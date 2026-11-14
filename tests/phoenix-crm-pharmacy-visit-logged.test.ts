import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { awaitsValidation, listRowAction, listSectionOf, onTheList } from "../src/lib/phoenix-crm/list-request-rules.ts";
import {
  ADDED_PHARMACY_NAME_MAX,
  addedPharmacyNameProblem,
  addedPharmacyNote,
  linkedPharmaciesNote,
  linkNamedPharmacies,
  linkNamedPharmacy,
  matchAddedPharmacy,
  pharmacyNameKey,
  pharmacyNamesOnVisit,
  splitNamedPharmacies,
  type ListedPharmacy,
} from "../src/lib/phoenix-crm/pharmacy-call-rules.ts";
import { todayPharmacies } from "../src/lib/phoenix-crm/today-rules.ts";

/**
 * Phoenix CRM — a pharmacy visit is logged normally (owner, 2026-10-03).
 *
 * Hassan (Pedia, El Mahalla) "visited pharmacies and submitted them but they appear as not visited at
 * all". Measured that day: no rep had EVER saved a pharmacy visit. The rules of 2026-10-02 (never
 * planned, never approved) were written in pharmacy-call-rules.ts and wired nowhere — the only way to a
 * pharmacy was Unplanned → Out of plan, a reason and an approval, and the database filed every pharmacy
 * visit out_of_plan. The owner's three rulings that day, each pinned below:
 *
 *   1. "Pharmacy don't need a validation. It is visit is logged normally." — a pending pharmacy is on
 *      the list, counts at once, and is reached from Add visit → Pharmacy visit with no reason.
 *   2. "consider this as a pharmacy visit and make it count everywhere" — the pharmacy a doctor's visit
 *      names gets its own visit, matched to his list or added to it.
 *   3. One pharmacy is one pharmacy however it is spelled — "ص.الفيومي" on the doctor's visit and the
 *      visit to "صيدلية الفيومي" count once in the day's Pharmacies figure.
 *   4. "fix a doctor visit that names two pharmacies in one box" — "صيدليه التهامي، صيدليه الرحمه" is
 *      two pharmacies, each matched, filed and counted on its own (section 8).
 *   5. "he can also add a pharmacy without any validation or without any approval" — Add a pharmacy,
 *      by its name alone, on the List and on Pharmacy visit (section 9).
 */

const ROOT = new URL("../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), "utf8");
const code = (file: string) => stripComments(read(file));

const VIEW_MIGRATION = "supabase/migrations/20261003174346_phoenix_crm_pharmacy_needs_no_validation.sql";
/** The column `linked_from_visit_id` and the trigger that names a pharmacy visit live here, and only here. */
const SAVE_MIGRATION = "supabase/migrations/20261003175653_phoenix_crm_pharmacy_visit_logged_normally.sql";
/** 175653's body with the link turned into one visit per name in the box (LOCK_MIGRATION keeps it all). */
const LINK_MIGRATION = "supabase/migrations/20261003202903_phoenix_crm_visit_names_two_pharmacies.sql";
/** Add a pharmacy by its name — no photo, no request, no approval (section 9). */
const ADD_MIGRATION = "supabase/migrations/20261003211501_phoenix_crm_add_pharmacy.sql";
/**
 * The save_visit and add_pharmacy that check a new pharmacy again under ONE lock, and whose add is a list event (section 10).
 * 20261006234611 patches save_visit in place afterwards (a chain with a product manager) and keeps every line of this.
 */
const LOCK_MIGRATION = "supabase/migrations/20261004005543_phoenix_crm_one_lock_for_a_new_pharmacy.sql";

export function runPhoenixCrmPharmacyVisitLoggedTests(): void {
  // ── 1. One pharmacy, however he spells it ─────────────────────────────────────────────────────
  {
    // Spellings reps typed on 2026-10-03, against the list's own names.
    assert.equal(pharmacyNameKey("ص.الفيومي"), pharmacyNameKey("صيدلية الفيومي"), "the reps' 'ص.' is the word pharmacy");
    assert.equal(pharmacyNameKey("صيدليه الفيومى"), pharmacyNameKey("صيدلية الفيومي"), "ة/ه and ى/ي are one letter to him");
    assert.equal(pharmacyNameKey("محمد العطار"), pharmacyNameKey("صيدلية محمد العطار"), "a name typed without 'pharmacy' is the same pharmacy");
    assert.equal(pharmacyNameKey("صيدلية أحمد"), pharmacyNameKey("صيدلية احمد"), "the alef forms fold");
    assert.equal(pharmacyNameKey("صيدلية ٢"), pharmacyNameKey("صيدلية 2"), "Arabic-Indic digits read as digits — the shared normalizer would drop them");
    assert.equal(pharmacyNameKey("El Ezaby — Nasr City"), pharmacyNameKey("el ezaby nasr city"), "case and punctuation never split one pharmacy");
    // 🔴 The Pharmacy Master's wider stop words are deliberately NOT dropped: there a person confirms
    // the suggestion, here a match files a visit with nobody looking.
    assert.notEqual(pharmacyNameKey("صيدلية النور"), pharmacyNameKey("صيدلية النور الجديدة"), "'the new Al Nour' can be a second pharmacy");
    assert.equal(pharmacyNameKey("   "), "", "a blank name has no key");
    assert.equal(pharmacyNameKey("صيدلية"), pharmacyNameKey("صيدليه"), "a name that is only the word keeps it, so it still compares");

    const rules = read("src/lib/phoenix-crm/pharmacy-call-rules.ts");
    assert.match(rules, /import \{ foldCustomerName \} from "@\/lib\/customer-master\/name-key";/, "the letters are folded by the repo's one pharmacy normalizer, never a second copy");
  }

  // ── 2. The pharmacy a doctor's visit names ────────────────────────────────────────────────────
  {
    const list: ListedPharmacy[] = [
      { customerId: "p-attar", name: "صيدلية محمد العطار", status: "pending" },
      { customerId: "p-fayoumi", name: "صيدلية الفيومي", status: "active" },
      { customerId: "p-nour", name: "صيدلية النور", status: "dropped" },
      { customerId: "p-shefa-1", name: "صيدلية الشفاء الكبرى", status: "pending" },
      { customerId: "p-shefa-2", name: "صيدلية الشفاء الصغرى", status: "pending" },
      { customerId: "p-makka-b", name: "صيدلية مكة", status: "pending" },
      { customerId: "p-makka-a", name: "صيدليه مكه", status: "active" },
    ];
    assert.deepEqual(linkNamedPharmacy("محمد العطار", list), { kind: "existing", customerId: "p-attar" }, "a pending pharmacy is his to visit — it needs no validation");
    assert.deepEqual(linkNamedPharmacy("ص.الفيومي", list), { kind: "existing", customerId: "p-fayoumi" });
    assert.deepEqual(linkNamedPharmacy("العطار", list), { kind: "existing", customerId: "p-attar" }, "a shorter name found inside exactly one pharmacy is that pharmacy");
    assert.deepEqual(linkNamedPharmacy("الشفاء", list), { kind: "none" }, "found inside TWO pharmacies: guessing would credit the wrong one");
    assert.deepEqual(linkNamedPharmacy("صيدلية النور", list), { kind: "none" }, "a pharmacy the SFE archived is never brought back by typing its name");
    assert.deepEqual(linkNamedPharmacy("مكة", list), { kind: "existing", customerId: "p-makka-a" }, "one pharmacy imported twice: the active row wins, every time");
    assert.deepEqual(linkNamedPharmacy("صيدلية الحياة", list), { kind: "new" }, "nothing on his list is it: it is added to his list");
    assert.deepEqual(linkNamedPharmacy("ال", list), { kind: "new" }, "too short to be found inside another name — never a partial match");
    assert.deepEqual(linkNamedPharmacy("", list), { kind: "none" });
    assert.deepEqual(linkNamedPharmacy(null, list), { kind: "none" }, "no name, no pharmacy visit");
  }

  // ── 3. A pharmacy needs no validation ─────────────────────────────────────────────────────────
  {
    const pharmacy = { status: "pending" as const, origin: "reference" as const, validatedAt: null, listType: "Pharmacy" };
    const doctor = { ...pharmacy, listType: "PM" };
    assert.equal(awaitsValidation(pharmacy), false, "Pharmacy don't need a validation");
    assert.equal(awaitsValidation(doctor), true, "a carried-over doctor still does");
    assert.equal(onTheList(pharmacy), true);
    assert.equal(listSectionOf(pharmacy), "your_list", "never under To validate");
    assert.equal(listSectionOf(doctor), "to_validate");
    assert.equal(listRowAction(pharmacy), "open", "its row offers Open, never Validate");
    assert.equal(listRowAction(doctor), "validate");
    assert.equal(listSectionOf({ ...pharmacy, status: "dropped" }), "archive", "a dropped pharmacy is still in the Archive");
    assert.equal(listSectionOf({ ...pharmacy, status: "outside" }), "outside");

    // The server must hand the section the list type, or every pharmacy reads as a doctor again.
    assert.match(code("src/lib/phoenix-crm/server/list.ts"), /section: listSectionOf\(\{ status, origin, validatedAt, listType: row\.list_type \}\),/);
    // And the visit form never tells him a pharmacy is "not validated yet".
    assert.match(code("src/lib/phoenix-crm/server/visits.ts"), /pending: row\.status === "pending" && !isPharmacyListType\(row\.list_type\),/);
    assert.match(code("src/lib/phoenix-crm/server/missed-records.ts"), /pending: row\.status === "pending" && !isPharmacyListType\(row\.list_type\),/);

    // The database answers the same: the countable view's validation half is true for every pharmacy.
    const view = stripSqlComments(read(VIEW_MIGRATION));
    assert.match(view, /\(c\.validated_at is not null or c\.list_type = 'Pharmacy'\) as customer_validated/);
    assert.doesNotMatch(view, /\bv\.\*/, "the column list is written out — v.* would now expand to a column the view does not have");
  }

  // ── 4. Add visit → Pharmacy visit, straight to the form ───────────────────────────────────────
  {
    const picker = code("src/components/phoenix-crm/visit-customer-picker.tsx");
    assert.match(picker, /export type PickerMode = "planned" \| "out_of_plan" \| "pharmacy";/);
    assert.match(
      picker,
      /if \(isPharmacyListType\(customer\.listType\)\) return mode === "pharmacy";\s*if \(mode === "pharmacy"\) return false;/,
      "a pharmacy is offered under Pharmacy visit and nowhere else — Out of plan asked it for a reason and an approval",
    );
    const flow = code("src/components/phoenix-crm/visits-tab.tsx");
    assert.match(
      flow,
      /if \(isPharmacyListType\(customer\.listType\)\) return \{ name: "form", customerId: customer\.customerId, visitType: "pharmacy", reason: null, back: null \};/,
      "opened from anywhere, a pharmacy goes straight to the form — never to the reason screen",
    );
    assert.match(flow, /onPick=\{\(customerId\) => onStep\(\{ name: "form", customerId, visitType: "pharmacy", reason: null, back: \{ name: "pharmacy" \} \}\)\}/);
    const start = code("src/components/phoenix-crm/visit-start.tsx");
    assert.match(start, /label="Pharmacy visit"/);
    const form = code("src/components/phoenix-crm/visit-log-form.tsx");
    assert.match(form, /visitType: visitType === "pharmacy" \? "planned" : visitType,/, "the server knows planned, out of plan and out of list — and re-decides it anyway");
    assert.match(form, /pharmacyName: atPharmacy \? null : pharmacyName\.trim\(\) \|\| null,/, "at the pharmacy there is no other pharmacy to name");
  }

  // ── 5. The database files it ──────────────────────────────────────────────────────────────────
  {
    const sql = stripSqlComments(read(LINK_MIGRATION));
    // The pharmacy branch comes FIRST, ahead of the out-of-list and out-of-plan ones.
    assert.match(
      sql,
      /if v_is_pharmacy then\s+v_on_sent_plan := true;\s+v_unplanned_kind := null;\s+elsif v_customer\.status = 'outside' then/,
      "a pharmacy is never out of plan, never out of list, never approved",
    );
    assert.match(sql, /if v_is_pharmacy then\s+v_pharmacy := left\(v_customer\.name, 120\);/, "its own visit is named after it, so the day's figure counts it");
    // The named pharmacy: checked to be HIS, added when none matched, one a day.
    assert.match(sql, /and c\.seat_id = v_seat\s+and c\.is_test = v_is_test\s+and c\.list_type = 'Pharmacy'\s+and c\.status in \('active', 'pending', 'outside'\);/);
    assert.match(sql, /'Pharmacy', v_entry_name, 'new', 'pending', v_actor, v_is_test,/, "a pharmacy added to his list is called as he spelled THAT pharmacy, never by the whole box");
    assert.match(sql, /on conflict \(seat_id, customer_id, visit_date, is_test\) do nothing/, "a pharmacy already visited today keeps the one visit it has");
    assert.match(sql, /null, null, 'no_place', v_is_test,/, "no place reading of its own");
    assert.match(sql, /revoke execute on function public\.phoenix_crm_save_visit\(jsonb\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function public\.phoenix_crm_save_visit\(jsonb\) to service_role;/);
    const first = stripSqlComments(read(SAVE_MIGRATION));
    assert.match(first, /add column if not exists linked_from_visit_id uuid\s+references public\.phoenix_crm_visits \(id\) on delete cascade;/);
    assert.match(first, /before insert on public\.phoenix_crm_visits\s+for each row execute function public\.phoenix_crm_visits_pharmacy_name\(\);/, "the Super Admin's missed-record entry is named too");
    // The caller sends the matches as `linked_pharmacies` only: every live database reads that array,
    // so the single-match fields a database on 20261003175653 read are no longer sent.
    const save = code("src/lib/phoenix-crm/server/visits.ts");
    assert.doesNotMatch(save, /linked_pharmacy_id|linked_pharmacy_new|pharmacyLink\b/, "no second, dead shape of the link");
  }

  // ── 6. The visit it files is part of the doctor's, not a second piece of work ─────────────────
  {
    const save = code("src/lib/phoenix-crm/server/visits.ts");
    const gate = save.slice(save.indexOf("async function isFirstVisitSubmittedBy("));
    const body = gate.slice(0, gate.indexOf("\n}\n") + 2);
    assert.match(body, /\.is\("linked_from_visit_id", null\)/, "written in the same transaction, it would make no visit ever a rep's first");
    // Same second, same reading as the doctor's: the behaviour sweep would read two visits in one second,
    // and the location report a "no place" visit nobody stood at.
    assert.match(code("src/lib/phoenix-crm/server/behaviour.ts"), /\.neq\("capture_source", "admin"\)\s*\.is\("linked_from_visit_id", null\)/);
    assert.match(code("src/lib/phoenix-crm/server/reports.ts"), /\.neq\("capture_source", "admin"\)\s*\.is\("linked_from_visit_id", null\);/);

    // Nothing of the doctor's visit is counted twice through it.
    const sql = stripSqlComments(read(LINK_MIGRATION));
    const linked = sql.slice(sql.indexOf("if v_link.id is not null then"), sql.indexOf("returning id into v_link_visit;"));
    assert.match(
      linked,
      /'Pharmacy', v_date, v_captured_at, 'single', v_rep,\s+case when v_rep is null then v_manager end,\s+null, null, v_actor, v_products, null, v_entry_name, '\{\}'::jsonb,/,
      "a SINGLE visit by the rep (or the manager on his own visit), with no stock answers of its own",
    );
    assert.doesNotMatch(linked, /v_kind|v_senior|v_product_manager|v_availability/, "never the doctor's double visit, its people or its stock answers a second time");
    const heard = code("src/lib/phoenix-crm/server/insight-reports.ts");
    const reader = heard.slice(heard.indexOf("async function heardVisits("), heard.indexOf("export async function loadFieldHeardReport("));
    assert.match(reader, /\)\.filter\(\(row\) => listTypeOf\(row\.list_type\) !== null\);/, "What the field heard is what DOCTORS said: a pharmacy visit is neither its AM nor its PM side");
  }

  // ── 7. The day counts one pharmacy once ───────────────────────────────────────────────────────
  {
    const day = todayPharmacies([
      { customerId: "dr", name: "Dr Samia", listType: "PM", doneAt: "11:40", pharmacyName: "ص.الفيومي" },
      { customerId: "ph", name: "صيدلية الفيومي", listType: "Pharmacy", doneAt: "11:40", pharmacyName: "صيدلية الفيومي" },
      { customerId: "dr2", name: "Dr Hany", listType: "AM", doneAt: "12:10", pharmacyName: "محمد العطار" },
    ]);
    assert.equal(day.length, 2, "the doctor's 'ص.الفيومي' and the pharmacy's own visit are ONE pharmacy");
    const fayoumi = day.find((entry) => pharmacyNameKey(entry.name) === pharmacyNameKey("الفيومي"));
    assert.deepEqual(fayoumi?.fromCustomers, ["Dr Samia"], "a pharmacy is never 'named on the visit to' itself");
    // The manager's calendar cell keys it the same way, so the cell and the day it opens agree.
    assert.match(
      code("src/lib/phoenix-crm/server/team-calendar.ts"),
      /for \(const name of pharmacyNamesOnVisit\(row\.list_type, String\(row\.pharmacy_name \?\? ""\)\)\) \{\s*const pharmacy = pharmacyNameKey\(name\);/,
    );
    assert.match(code("src/lib/phoenix-crm/day-detail.ts"), /countedNames\.has\(pharmacyNameKey\(entry\.name\)\)/);
  }

  // ── 8. One box, two pharmacies (owner, 2026-10-03) ────────────────────────────────────────────
  {
    // The three boxes measured on production that day — Mohamed Salem (Pedia), all with the Arabic comma.
    assert.deepEqual(splitNamedPharmacies("صيدليه التهامي، صيدليه الرحمه"), ["صيدليه التهامي", "صيدليه الرحمه"]);
    assert.deepEqual(splitNamedPharmacies("صيدليه الوكيل ،صيدليه الكوانيني"), ["صيدليه الوكيل", "صيدليه الكوانيني"]);
    assert.deepEqual(splitNamedPharmacies("كوانيني ،الوكيل"), ["كوانيني", "الوكيل"]);
    assert.deepEqual(splitNamedPharmacies("صيدلية التهامي, صيدلية الرحمه; صيدلية يونس"), ["صيدلية التهامي", "صيدلية الرحمه", "صيدلية يونس"], "the Latin comma and semicolon too");
    assert.deepEqual(splitNamedPharmacies("صيدلية التهامي وصيدلية الرحمه"), ["صيدلية التهامي", "صيدلية الرحمه"], "'and' before the word pharmacy");
    assert.deepEqual(splitNamedPharmacies("ص.التهامي و ص.الرحمه"), ["ص.التهامي", "ص.الرحمه"]);
    // 🔴 One pharmacy stays ONE: the reps' "ص/" is the word pharmacy, "-" names a branch, and "و" inside a
    // name is a letter.
    assert.deepEqual(splitNamedPharmacies("ص/ناصر"), ["ص/ناصر"]);
    assert.deepEqual(splitNamedPharmacies("صيدلية العطار - الفرع التاني"), ["صيدلية العطار - الفرع التاني"]);
    assert.deepEqual(splitNamedPharmacies("الفرع التاني ص العطار"), ["الفرع التاني ص العطار"]);
    assert.deepEqual(splitNamedPharmacies("صيدلية محمد وصفي"), ["صيدلية محمد وصفي"]);
    // "و" splits only between TWO mentions of the word pharmacy, and "+" and "&" are part of a name.
    assert.deepEqual(splitNamedPharmacies("مخزن وصيدلية الشفاء"), ["مخزن وصيدلية الشفاء"], "never a pharmacy called 'مخزن' added to his list");
    assert.deepEqual(splitNamedPharmacies("مخلص للدواء وصيدلية الشفاء"), ["مخلص للدواء وصيدلية الشفاء"], "a word ending in ص is not the reps' 'ص'");
    assert.deepEqual(splitNamedPharmacies("صيدلية A & B"), ["صيدلية A & B"], "'&' is part of one pharmacy's name");
    assert.deepEqual(splitNamedPharmacies("صيدلية العطار + الشفاء"), ["صيدلية العطار + الشفاء"], "'+' is part of one pharmacy's name");
    assert.deepEqual(splitNamedPharmacies("صيدليه التهامي، ص.التهامي"), ["صيدليه التهامي"], "a second spelling of one pharmacy is that pharmacy");
    assert.deepEqual(splitNamedPharmacies("صيدلية التهامي، صيدلية"), ["صيدلية التهامي"], "a part that is only the word pharmacy names none");
    assert.deepEqual(splitNamedPharmacies(" ، ،"), []);
    assert.deepEqual(splitNamedPharmacies(null), []);
    assert.equal(splitNamedPharmacies("ص أ، ص ب، ص ج، ص د، ص ه، ص و").length, 6, "every name is read — the day counts each one");

    // A pharmacy's OWN visit is one pharmacy, whatever its name holds; a doctor's box is what it names.
    assert.deepEqual(pharmacyNamesOnVisit("Pharmacy", "صيدلية العزبي، فرع مدينة نصر"), ["صيدلية العزبي، فرع مدينة نصر"]);
    assert.deepEqual(pharmacyNamesOnVisit("PM", "صيدليه التهامي، صيدليه الرحمه"), ["صيدليه التهامي", "صيدليه الرحمه"]);
    assert.deepEqual(pharmacyNamesOnVisit("Pharmacy", "  "), []);

    // Matched one name at a time, against his list as it stood that evening (seat D11).
    const d11: ListedPharmacy[] = [
      { customerId: "tohamy", name: "صيدلية التهامي", status: "pending" },
      { customerId: "kawanini", name: "صيدلية الكوانيني", status: "pending" },
      { customerId: "wakil", name: "صيدلية الوكيل", status: "pending" },
      { customerId: "alaa-wakil", name: "صيدلية علاء الوكيل", status: "pending" },
      { customerId: "nour", name: "صيدلية النور", status: "dropped" },
    ];
    assert.deepEqual(linkNamedPharmacy("صيدليه الوكيل ،صيدليه الكوانيني", d11), { kind: "none" }, "the whole box half-matches two pharmacies — which is why 20:19 filed nothing");
    assert.deepEqual(linkNamedPharmacies("صيدليه الوكيل ،صيدليه الكوانيني", d11), [
      { name: "صيدليه الوكيل", link: { kind: "existing", customerId: "wakil" } },
      { name: "صيدليه الكوانيني", link: { kind: "existing", customerId: "kawanini" } },
    ]);
    assert.deepEqual(linkNamedPharmacies("كوانيني ،الوكيل", d11), [
      { name: "كوانيني", link: { kind: "existing", customerId: "kawanini" } },
      { name: "الوكيل", link: { kind: "existing", customerId: "wakil" } },
    ]);
    assert.deepEqual(linkNamedPharmacies("صيدليه التهامي، صيدليه الرحمه", d11), [
      { name: "صيدليه التهامي", link: { kind: "existing", customerId: "tohamy" } },
      { name: "صيدليه الرحمه", link: { kind: "new" } },
    ], "one on his list, one added to it");
    assert.deepEqual(linkNamedPharmacies("صيدلية الكوانيني، كوانيني", d11), [
      { name: "صيدلية الكوانيني", link: { kind: "existing", customerId: "kawanini" } },
    ], "two spellings that land on ONE pharmacy file it once");
    assert.deepEqual(linkNamedPharmacies("صيدلية النور، صيدلية التهامي", d11), [
      { name: "صيدلية التهامي", link: { kind: "existing", customerId: "tohamy" } },
    ], "a pharmacy the SFE archived is still never brought back — the other name is filed");
    // Five filed at most — the database files no more — counted AFTER the names that match nothing.
    const six = linkNamedPharmacies("صيدلية النور، صيدلية الف، صيدلية باء، صيدلية جيم، صيدلية دال، صيدلية هاء", d11);
    assert.equal(six.length, 5);
    assert.equal(six[4]?.name, "صيدلية هاء", "the archived first name never takes the sixth name's place");
    assert.equal(linkNamedPharmacies("ص أ، ص ب، ص ج، ص د، ص ه، ص و", d11).length, 5);

    // What he reads once it is saved.
    assert.equal(linkedPharmaciesNote([]), null);
    assert.equal(linkedPharmaciesNote([{ name: "صيدلية التهامي", created: false }]), "صيدلية التهامي is logged as a pharmacy visit too.");
    assert.equal(linkedPharmaciesNote([{ name: "صيدلية الرحمه", created: true }]), "صيدلية الرحمه is logged as a pharmacy visit too, and added to your list.");
    assert.equal(
      linkedPharmaciesNote([{ name: "صيدلية التهامي", created: false }, { name: "صيدلية الرحمه", created: true }]),
      "صيدلية التهامي and صيدلية الرحمه are logged as pharmacy visits too. صيدلية الرحمه is added to your list.",
    );
    assert.equal(
      linkedPharmaciesNote([{ name: "A", created: true }, { name: "B", created: false }, { name: "C", created: true }]),
      "A, B and C are logged as pharmacy visits too. A and C are added to your list.",
    );

    // The day counts two pharmacies, not a third called by both names.
    const day = todayPharmacies([
      { customerId: "dr", name: "دعاء عادل فوده", listType: "PM", doneAt: "19:29", pharmacyName: "صيدليه التهامي، صيدليه الرحمه" },
      { customerId: "ph1", name: "صيدلية التهامي", listType: "Pharmacy", doneAt: "19:29", pharmacyName: "صيدليه التهامي" },
      { customerId: "ph2", name: "صيدلية الرحمه", listType: "Pharmacy", doneAt: "19:29", pharmacyName: "صيدليه الرحمه" },
    ]);
    assert.equal(day.length, 2, "التهامي and الرحمه — two pharmacies, never three");
    assert.deepEqual(day.map((entry) => entry.fromCustomers), [["دعاء عادل فوده"], ["دعاء عادل فوده"]], "each is named on the doctor's visit");

    // The caller sends one entry per name, and nothing else.
    const save = code("src/lib/phoenix-crm/server/visits.ts");
    assert.match(save, /const pharmacyLinks = linkNamedPharmacies\(visit\.pharmacyName, listedPharmacies\);/);
    assert.match(save, /linked_pharmacies: pharmacyLinks\.map\(\(\{ name, link \}\) => \(\{\s*name,\s*id: link\.kind === "existing" \? link\.customerId : null,\s*new: link\.kind === "new",\s*\}\)\),/);
    assert.match(
      save,
      /for \(const name of splitNamedPharmacies\(textOrNull\(row\.pharmacy_name\)\)\) \{\s*if \(names\.length >= 50\) break rows;\s*offer\(name\);/,
      "a two-name box is offered as the two names, never as one suggestion — and the 50 holds per NAME",
    );
    assert.match(save, /Array\.isArray\(result\.linked_pharmacies\) \? result\.linked_pharmacies : \[\]/);

    // The database files one visit per entry, named as he spelled it, and reads an old caller as one.
    const sql = stripSqlComments(read(LINK_MIGRATION));
    assert.match(sql, /when jsonb_typeof\(p -> 'linked_pharmacies'\) = 'array' then p -> 'linked_pharmacies'/);
    assert.match(sql, /'name', v_pharmacy,\s+'id', nullif\(p ->> 'linked_pharmacy_id', ''\),\s+'new', coalesce\(\(p ->> 'linked_pharmacy_new'\)::boolean, false\)/, "a caller from before sends one match, named with the whole box as 175653 named it");
    assert.match(sql, /from jsonb_array_elements\(v_links\) with ordinality as e\(value, n\) order by e\.n limit 5/);
    assert.match(sql, /continue when v_entry_name is null or char_length\(v_entry_name\) > 120;/, "a name it cannot file is skipped, never raised — the doctor's visit is saved whatever");
    assert.match(sql, /'linked_pharmacy', v_filed -> 0,\s+'linked_pharmacies', v_filed,/);
    assert.doesNotMatch(sql, /raise exception[^;]*v_entry/, "nothing about a named pharmacy can refuse the doctor's visit");
  }

  // ── 9. He adds a pharmacy himself, by its name, with no approval ─────────────────────────────
  // Owner, 2026-10-03: "he can add to his list pharmacies without approval normally … in pharmacy visit
  // … all his pharmacies to be listed and he can also add a pharmacy without any validation or without
  // any approval".
  {
    // The name is all it asks for — and a name, not only the word pharmacy.
    assert.equal(addedPharmacyNameProblem("صيدلية الشفاء"), null);
    assert.equal(addedPharmacyNameProblem("  El Ezaby  "), null);
    assert.equal(addedPharmacyNameProblem(""), "Write the pharmacy's name.");
    assert.equal(addedPharmacyNameProblem("   "), "Write the pharmacy's name.");
    assert.equal(addedPharmacyNameProblem(null), "Write the pharmacy's name.");
    for (const word of ["صيدلية", "صيدليه", "ص.", "ص", "Pharmacy"]) {
      assert.equal(addedPharmacyNameProblem(word), "Write the pharmacy's own name, not only the word pharmacy.", `"${word}" alone names no pharmacy`);
    }
    assert.equal(addedPharmacyNameProblem("ن".repeat(121)), "Keep the name to 120 characters.");
    assert.equal(addedPharmacyNameProblem("ن".repeat(120)), null);
    // 🔴 The same 120 as a visit's pharmacy_name: a pharmacy's own visit is named after it, so a longer
    // name would be accepted here and refused on its first visit.
    assert.match(code("src/lib/phoenix-crm/entry-rules.ts"), new RegExp(`export const PHARMACY_NAME_MAX = ${ADDED_PHARMACY_NAME_MAX};`));

    // EXACTLY by its key: on his list already → opened, never a second row; archived → asked back from
    // the Archive; anything else → added. Never the doctor box's half-match.
    const listed: ListedPharmacy[] = [
      { customerId: "c-shefa", name: "صيدلية الشفاء", status: "pending" },
      { customerId: "c-nour-new", name: "صيدلية النور الجديدة", status: "active" },
      { customerId: "c-old", name: "صيدلية القديمة", status: "dropped" },
      { customerId: "b-twice", name: "صيدلية مكة", status: "pending" },
      { customerId: "a-twice", name: "صيدليه مكه", status: "active" },
    ];
    assert.deepEqual(matchAddedPharmacy("ص.الشفاء", listed), { kind: "existing", customerId: "c-shefa", name: "صيدلية الشفاء" }, "his spelling of a pharmacy on his list opens it");
    assert.deepEqual(matchAddedPharmacy("صيدلية النور", listed), { kind: "new" }, "'Al Nour' is NOT 'the new Al Nour' — a half-match would hand him a pharmacy he did not ask for");
    assert.deepEqual(matchAddedPharmacy("صيدلية القديمة", listed), { kind: "archived", customerId: "c-old", name: "صيدلية القديمة" }, "typing never undoes the Archive");
    assert.deepEqual(matchAddedPharmacy("مكة", listed), { kind: "existing", customerId: "a-twice", name: "صيدليه مكه" }, "one pharmacy imported twice: the active row wins");
    assert.deepEqual(matchAddedPharmacy("صيدلية جديدة تماما", listed), { kind: "new" });

    assert.equal(addedPharmacyNote({ customerName: "صيدلية الشفاء", created: true }), "صيدلية الشفاء is on your list. No approval: its visits count in Pharmacies, never in AM or PM.");
    assert.equal(addedPharmacyNote({ customerName: "صيدلية الشفاء", created: false }), "صيدلية الشفاء is already on your list.");

    // The service: the rep's own write, the name checked, matched against his list, then the database.
    const list = code("src/lib/phoenix-crm/server/list.ts");
    const service = /export async function addPharmacy\([\s\S]*?\n\}/.exec(list)?.[0] ?? "";
    assert.ok(service, "addPharmacy is the service behind Add a pharmacy");
    assert.match(service, /territoryForRepWrite\(viewer, body\.seatId, readTestFlag\(body\.test\)\)/, "the territory's own rep, never a manager");
    assert.match(service, /addedPharmacyNameProblem\(/);
    assert.match(service, /matchAddedPharmacy\(name, await loadListedPharmacies\(seat\.seatId, isTest\)\)/);
    assert.match(service, /callPhoenixCrm<Row>\("phoenix_crm_add_pharmacy"/);
    assert.doesNotMatch(service, /firstRequestStage|notifyRequestRaised|request_kind|parsePlaceDraft|photo/i, "no request, no approval and no photo: on his list at once");
    assert.match(code("app/api/phoenix-crm/list/pharmacy/route.ts"), /addPharmacy\(viewer, body\)/);

    // The database: a pending pharmacy, origin new, under a per-territory lock that repeats the
    // exact-name check — so a double tap adds one pharmacy. No request row of any kind.
    const sql = stripSqlComments(read(ADD_MIGRATION));
    assert.match(sql, /perform pg_advisory_xact_lock\(hashtext\('phoenix_crm_add_pharmacy\|' \|\| v_seat \|\| '\|' \|\| v_is_test::text\)\);/);
    assert.match(sql, /and c\.list_type = 'Pharmacy'\s+and c\.status in \('active', 'pending', 'outside'\)/);
    assert.match(sql, /values \(\s+v_seat, v_line, 'Pharmacy', v_name, 'new', 'pending', v_actor, v_is_test,/);
    assert.match(sql, /or char_length\(v_name\) > 120/);
    assert.doesNotMatch(sql, /phoenix_crm_list_requests|phoenix_crm_places/, "it files no request and asks for no place");

    // ── 10. One lock for a new pharmacy, and its add is on the record (review of #5263) ──────────
    // A doctor's box decides "new" from a read taken BEFORE the call, so the database checks the name
    // again under the very lock Add a pharmacy takes — two saves, or a save and an add, file ONE row.
    const lock = stripSqlComments(read(LOCK_MIGRATION));
    const lockKey = /pg_advisory_xact_lock\(hashtext\('phoenix_crm_add_pharmacy\|' \|\| v_seat \|\| '\|' \|\| v_is_test::text\)\)/g;
    assert.equal(lock.match(lockKey)?.length, 2, "save_visit's new pharmacy and add_pharmacy take ONE lock");
    const branch = lock.slice(lock.indexOf("elsif v_entry_new then"), lock.indexOf("if v_link.id is not null then"));
    assert.match(
      branch,
      /perform pg_advisory_xact_lock[\s\S]*?select c\.\* into v_link[\s\S]*?and c\.status in \('active', 'pending', 'outside'\)[\s\S]*?if v_link\.id is null then\s+insert into public\.phoenix_crm_customers/,
      "the name is looked for again under the lock, and added only when it is still not there",
    );
    const added = lock.slice(lock.indexOf("create or replace function public.phoenix_crm_add_pharmacy("));
    assert.match(
      added,
      /insert into public\.phoenix_crm_list_events \(seat_id, customer_id, event_type, actor_hr_id, details, is_test\)\s+values \(\s+v_seat, v_added\.id, 'pharmacy_added', v_actor,/,
      "a pharmacy added by name leaves a list event, as every other way onto the list does",
    );

    // The two doors: the List's header, and Pharmacy visit — which opens the visit form on the new one.
    const tab = code("src/components/phoenix-crm/list-tab.tsx");
    assert.match(tab, /onClick=\{\(\) => onOpen\(\{ name: "add-pharmacy" \}\)\}/);
    assert.match(tab, /case "add-pharmacy":[\s\S]*?<AddPharmacyScreen[\s\S]*?from="list"/);
    const visits = code("src/components/phoenix-crm/visits-tab.tsx");
    assert.match(visits, /onAddPharmacy=\{loaded\.enteredAs === "rep" \? \(\) => onStep\(\{ name: "pharmacy_new" \}\) : undefined\}/);
    assert.match(
      visits,
      /case "pharmacy_new":[\s\S]*?from="visit"[\s\S]*?resource\.reload\(\);\s*onStep\(\{ name: "form", customerId: added\.customerId, visitType: "pharmacy", reason: null, back: \{ name: "pharmacy" \} \}\);/,
      "a pharmacy added on Pharmacy visit goes straight to its visit form",
    );
    const picker = code("src/components/phoenix-crm/visit-customer-picker.tsx");
    assert.match(picker, /\{mode === "pharmacy" && onAddPharmacy \? \(/, "Add a pharmacy sits on Pharmacy visit and nowhere else in the picker");
    const screen = code("src/components/phoenix-crm/add-pharmacy.tsx");
    // The NAME is all the route needs, and that is the half this rule owns: the body carries seatId,
    // test, name and from, and the two extras the owner added on 2026-10-09 — an optional pin and an
    // optional phone — are SPREAD IN ONLY WHEN HE FILLED THEM, so an add with neither is byte for byte
    // the body this route has always received. (That the extras exist at all is
    // tests/phoenix-crm-pharmacy-pin.test.ts's rule; what is pinned here is that they are optional.)
    assert.match(screen, /crmPost<AddedPharmacy>\(\s*"\/api\/phoenix-crm\/list\/pharmacy",\s*\{ seatId, test, name, from, \.\.\.\(phone\.trim\(\) \? \{ phone \} : \{\}\), \.\.\.\(pin \? \{ pin \} : \{\}\) \},\s*"result",\s*\)/);
    // Still no evidence and no hours: a pharmacy is never validated, so there is no photo to take and
    // no opening time to agree. The pin is a record the rep may leave empty, not a reading anyone checks.
    assert.doesNotMatch(screen, /LivePhotoCapture|PlaceEditor|TimingsEditor/, "no photo, no hours");

    // Pharmacy visit lists every pharmacy on his list — validated or not: the form reads pending ones too.
    // The statuses are decided once and handed to both doors of the territory read (2 Nov 2026): the
    // one-statement function and the page-walk fallback.
    assert.match(list, /const statuses = options\.onListOnly \? \(options\.includeOutside \? \["active", "pending", "outside"\] : \["active", "pending"\]\) : null;/);
    assert.match(list, /p_statuses: statuses,/, "the function is asked for the same statuses");
    assert.match(list, /if \(statuses\) query = query\.in\("status", statuses\);/, "and so is the fallback");
  }
}
