import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { awaitsValidation, listRowAction, listSectionOf, onTheList } from "../src/lib/phoenix-crm/list-request-rules.ts";
import { linkNamedPharmacy, pharmacyNameKey, type ListedPharmacy } from "../src/lib/phoenix-crm/pharmacy-call-rules.ts";
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
 */

const ROOT = new URL("../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), "utf8");
const code = (file: string) => stripComments(read(file));

const VIEW_MIGRATION = "supabase/migrations/20261003174346_phoenix_crm_pharmacy_needs_no_validation.sql";
const SAVE_MIGRATION = "supabase/migrations/20261003175653_phoenix_crm_pharmacy_visit_logged_normally.sql";

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
    assert.match(rules, /import \{ normalizeArabicPharmacyName \} from "@\/lib\/pharmacy-master\/pharmacy-matching";/, "the letters are folded by the repo's one pharmacy normalizer, never a second copy");
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
    const sql = stripSqlComments(read(SAVE_MIGRATION));
    // The pharmacy branch comes FIRST, ahead of the out-of-list and out-of-plan ones.
    assert.match(
      sql,
      /if v_is_pharmacy then\s+v_on_sent_plan := true;\s+v_unplanned_kind := null;\s+elsif v_customer\.status = 'outside' then/,
      "a pharmacy is never out of plan, never out of list, never approved",
    );
    assert.match(sql, /if v_is_pharmacy then\s+v_pharmacy := left\(v_customer\.name, 120\);/, "its own visit is named after it, so the day's figure counts it");
    // The named pharmacy: checked to be HIS, added when none matched, one a day.
    assert.match(sql, /and c\.seat_id = v_seat\s+and c\.is_test = v_is_test\s+and c\.list_type = 'Pharmacy'\s+and c\.status in \('active', 'pending', 'outside'\);/);
    assert.match(sql, /'Pharmacy', v_pharmacy, 'new', 'pending', v_actor, v_is_test,/);
    assert.match(sql, /on conflict \(seat_id, customer_id, visit_date, is_test\) do nothing/, "a pharmacy already visited today keeps the one visit it has");
    assert.match(sql, /null, null, 'no_place', v_is_test,/, "no place reading of its own");
    assert.match(sql, /add column if not exists linked_from_visit_id uuid\s+references public\.phoenix_crm_visits \(id\) on delete cascade;/);
    assert.match(sql, /revoke execute on function public\.phoenix_crm_save_visit\(jsonb\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function public\.phoenix_crm_save_visit\(jsonb\) to service_role;/);
    assert.match(sql, /before insert on public\.phoenix_crm_visits\s+for each row execute function public\.phoenix_crm_visits_pharmacy_name\(\);/, "the Super Admin's missed-record entry is named too");
    // The caller sends the match; a pharmacy customer's own visit sends none of it.
    const save = code("src/lib/phoenix-crm/server/visits.ts");
    assert.match(save, /linked_pharmacy_id: pharmacyLink\.kind === "existing" \? pharmacyLink\.customerId : null,/);
    assert.match(save, /linked_pharmacy_new: pharmacyLink\.kind === "new",/);
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
    const sql = stripSqlComments(read(SAVE_MIGRATION));
    const linked = sql.slice(sql.indexOf("if v_link.id is not null then"), sql.indexOf("returning id into v_link_visit;"));
    assert.match(
      linked,
      /'Pharmacy', v_date, v_captured_at, 'single', v_rep,\s+case when v_rep is null then v_manager end,\s+null, null, v_actor, v_products, null, v_pharmacy, '\{\}'::jsonb,/,
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
    assert.match(code("src/lib/phoenix-crm/server/team-calendar.ts"), /const pharmacy = pharmacyNameKey\(String\(row\.pharmacy_name \?\? ""\)\);/);
    assert.match(code("src/lib/phoenix-crm/day-detail.ts"), /countedNames\.has\(pharmacyNameKey\(entry\.name\)\)/);
  }
}
