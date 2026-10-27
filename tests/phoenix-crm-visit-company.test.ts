import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { parseVisitDraft } from "../src/lib/phoenix-crm/entry-rules.ts";
import {
  CHOOSE_ONE_FOR_DOUBLE,
  CHOOSE_TWO_FOR_CHAIN,
  COMPANY_NOT_OFFERED,
  COMPANY_PICKS,
  canPick,
  companyFromStorage,
  companyHint,
  companyToStorage,
  togglePick,
  type CompanyOffer,
} from "../src/lib/phoenix-crm/visit-company.ts";
import {
  VISIT_PEOPLE_FIXED_MANAGER_ENTRY,
  VISIT_PEOPLE_FIXED_NO_REP,
  parseVisitEdit,
  visitWhoEditable,
} from "../src/lib/phoenix-crm/visit-edit-rules.ts";

/**
 * Phoenix CRM — Double visit takes ONE person, Chain visit takes TWO, and the Super Admin can correct a
 * visit a rep submitted (owner, 2026-10-06).
 *
 * "If he chooses double visit, his district manager appear, the product manager appear, the national
 * sales manager appear, and he can choose only one … and if applicable, the regional manager. Also in
 * the chain visit, all those appear, but he can choose two, not one." And: "make the admin able to edit
 * a visit submitted by an employee. Example, if he chooses a wrong double visit, make me able to enter
 * and edit it."
 *
 * 🔴 WHAT THIS PINS IS THE ARITHMETIC AND THE FENCES: how many each choice takes, what each pick is FILED
 * AS (a product manager under Double is still the `product_manager` kind, never a double — `double_visits`
 * is counted from `kind = 'double'`), that a correction can only ever touch who/products/comment, that it
 * is the Super Admin's alone, and that it tells nobody.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}
function source(path: string): string {
  return stripComments(read(path));
}

// The list a rep's territory offers: district manager, regional manager, national sales manager (nearest
// first), then his line's two product managers.
const DM: CompanyOffer = { hrId: "B-12", role: "manager", position: 0 };
const RM: CompanyOffer = { hrId: "R-1", role: "manager", position: 1 };
const NSM: CompanyOffer = { hrId: "A-12", role: "manager", position: 2 };
const PM1: CompanyOffer = { hrId: "PM-1", role: "product_manager", position: null };
const PM2: CompanyOffer = { hrId: "PM-2", role: "product_manager", position: null };
const OFFERS = [DM, RM, NSM, PM1, PM2];

function stored(choice: "single" | "double" | "chain", picked: string[]) {
  return companyToStorage({ choice, offers: OFFERS, picked });
}
function value(choice: "single" | "double" | "chain", picked: string[]) {
  const result = stored(choice, picked);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) return null;
  // The fixed places only — everyone on the visit (`companions`) is pinned in phoenix-crm-visit-any-companions.
  const { kind, managerHrId, seniorHrId, productManagerHrId } = result.value;
  return { kind, managerHrId, seniorHrId, productManagerHrId };
}
function refusal(choice: "single" | "double" | "chain", picked: string[]): string {
  const result = stored(choice, picked);
  assert.equal(result.ok, false, `${choice} ${picked.join("+")} was expected to be refused`);
  return result.ok ? "" : result.error;
}

const VISIT_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT = {
  customerId: "22222222-2222-4222-8222-222222222222",
  products: ["Saginko"],
  comment: "Discussed the new pack",
  visitType: "planned",
  lat: 30.05,
  lon: 31.23,
  accuracyMeters: 12,
  deviceCapturedAt: "2026-10-06T09:00:00.000Z",
};

export function runPhoenixCrmVisitCompanyTests(): void {
  // ── 1. How many each choice takes ─────────────────────────────────────────────────────────────
  {
    assert.deepEqual(COMPANY_PICKS, { single: 0, double: 1, chain: 2 }, "single none, double ONE, chain TWO OR MORE — the owner's words");
    assert.equal(companyHint("double", 0), "Choose one.");
    assert.equal(companyHint("chain", 1), "Choose two or more — 1 chosen.");
    assert.equal(companyHint("single", 0), "");

    assert.equal(refusal("double", []), CHOOSE_ONE_FOR_DOUBLE, "a double with nobody picked");
    assert.equal(refusal("double", ["B-12", "A-12"]), CHOOSE_ONE_FOR_DOUBLE, "a double never takes two");
    assert.equal(refusal("chain", ["B-12"]), CHOOSE_TWO_FOR_CHAIN, "a chain with one");
    // Owner, 2026-10-27: "Everything is applicable" — a chain takes three managers, and more.
    assert.deepEqual(value("chain", ["B-12", "R-1", "A-12"]), { kind: "chain", managerHrId: "B-12", seniorHrId: "R-1", productManagerHrId: null }, "a chain takes three");
    assert.equal(refusal("chain", ["B-12", "b-12"]), CHOOSE_TWO_FOR_CHAIN, "the same person twice is one person");
    assert.equal(refusal("single", ["B-12"]), COMPANY_NOT_OFFERED, "a single visit has nobody with the rep");
    assert.equal(refusal("double", ["X-99"]), COMPANY_NOT_OFFERED, "somebody the list never offered");
    assert.equal(refusal("chain", ["B-12", "X-99"]), COMPANY_NOT_OFFERED);
  }

  // ── 2. What each pick is FILED AS ─────────────────────────────────────────────────────────────
  {
    assert.deepEqual(value("single", []), { kind: "single", managerHrId: null, seniorHrId: null, productManagerHrId: null });

    // A manager under Double is a double visit.
    assert.deepEqual(value("double", ["R-1"]), { kind: "double", managerHrId: "R-1", seniorHrId: null, productManagerHrId: null }, "the regional manager is offered and filed as the visit's manager");
    assert.deepEqual(value("double", ["a-12"]), { kind: "double", managerHrId: "A-12", seniorHrId: null, productManagerHrId: null }, "the national sales manager too, filed as the OFFER spells him");

    // 🔴 A product manager under Double is the `product_manager` kind it always was — NEVER a double visit
    // and NEVER in the manager slot, because `double_visits` is counted from kind = 'double' on every
    // board and district managers are judged on it.
    assert.deepEqual(value("double", ["PM-1"]), { kind: "product_manager", managerHrId: null, seniorHrId: null, productManagerHrId: "PM-1" });

    // Two managers: the NEARER one is the visit's manager and the one above him its senior, whichever
    // was ticked first.
    const nearFirst = { kind: "chain", managerHrId: "B-12", seniorHrId: "A-12", productManagerHrId: null };
    assert.deepEqual(value("chain", ["B-12", "A-12"]), nearFirst);
    assert.deepEqual(value("chain", ["A-12", "B-12"]), nearFirst, "the order he ticked them in does not matter");
    assert.deepEqual(value("chain", ["A-12", "R-1"]), { kind: "chain", managerHrId: "R-1", seniorHrId: "A-12", productManagerHrId: null });

    // A manager and a product manager: his own slot, and the senior slot stays empty.
    const withPm = { kind: "chain", managerHrId: "B-12", seniorHrId: null, productManagerHrId: "PM-2" };
    assert.deepEqual(value("chain", ["B-12", "PM-2"]), withPm);
    assert.deepEqual(value("chain", ["PM-2", "B-12"]), withPm);

    // 🔴 The product side alone, however many came, is the product-manager kind (2026-10-27): nobody from
    // the management line was there, so it never reaches `double_visits`.
    assert.deepEqual(value("chain", ["PM-1", "PM-2"]), { kind: "product_manager", managerHrId: null, seniorHrId: null, productManagerHrId: "PM-1" });
  }

  // ── 3. A stored visit reads back as the choice and the people to tick ─────────────────────────
  {
    assert.deepEqual(companyFromStorage({ kind: "single", managerHrId: null, seniorHrId: null, productManagerHrId: null }), { choice: "single", picked: [] });
    assert.deepEqual(companyFromStorage({ kind: "double", managerHrId: "B-12", seniorHrId: null, productManagerHrId: null }), { choice: "double", picked: ["B-12"] });
    assert.deepEqual(
      companyFromStorage({ kind: "product_manager", managerHrId: null, seniorHrId: null, productManagerHrId: "PM-1" }),
      { choice: "double", picked: ["PM-1"] },
      "a product manager reads as the rep put it: ONE person under Double visit",
    );
    assert.deepEqual(companyFromStorage({ kind: "chain", managerHrId: "B-12", seniorHrId: "A-12", productManagerHrId: null }), { choice: "chain", picked: ["B-12", "A-12"] });
    assert.deepEqual(companyFromStorage({ kind: "chain", managerHrId: "B-12", seniorHrId: null, productManagerHrId: "PM-1" }), { choice: "chain", picked: ["B-12", "PM-1"] });

    // And every shape survives the round trip: what a rep ticks, files, and reads back is the same people.
    for (const [choice, picked] of [
      ["single", []],
      ["double", ["B-12"]],
      ["double", ["PM-2"]],
      ["chain", ["B-12", "R-1"]],
      ["chain", ["R-1", "PM-1"]],
    ] as const) {
      const slots = value(choice, [...picked]);
      assert.ok(slots);
      const back = companyFromStorage(slots);
      assert.equal(back.choice, choice);
      assert.deepEqual([...back.picked].sort(), [...picked].sort(), `${choice} ${picked.join("+")} round-trips`);
    }
  }

  // ── 4. The picker's own rules ─────────────────────────────────────────────────────────────────
  {
    assert.deepEqual(togglePick("double", [], "B-12"), ["B-12"]);
    assert.deepEqual(togglePick("double", ["B-12"], "A-12"), ["A-12"], "a double has one place, so a new pick REPLACES the old one");
    assert.deepEqual(togglePick("double", ["B-12"], "B-12"), [], "ticking him again takes him off");
    assert.deepEqual(togglePick("chain", ["B-12"], "A-12"), ["B-12", "A-12"]);
    assert.deepEqual(togglePick("chain", ["B-12", "A-12"], "R-1"), ["B-12", "A-12", "R-1"], "a chain takes a third (2026-10-27)");
    const full = Array.from({ length: 12 }, (_, index) => `F-${index}`);
    assert.deepEqual(togglePick("chain", full, "R-1"), full, "a full visit — twelve besides the rep — takes no thirteenth");
    assert.deepEqual(togglePick("chain", ["B-12", "A-12"], "A-12"), ["B-12"]);
    assert.deepEqual(togglePick("single", ["B-12"], "A-12"), [], "a single visit holds nobody");

    assert.equal(canPick("chain", full, RM), false, "a full visit disables the rest");
    assert.equal(canPick("chain", ["B-12", "A-12"], RM), true, "two ticked leaves room for a third");
    assert.equal(canPick("chain", ["B-12", "A-12"], NSM), true, "and a ticked person stays tickable so he can be taken off");
    assert.equal(canPick("chain", ["PM-1"], PM2), true, "a second product-side person on a chain (2026-10-27)");
    assert.equal(canPick("chain", ["PM-1"], DM), true);
    assert.equal(canPick("double", ["PM-1"], PM2), true, "under Double any one of the list may replace the pick");
    assert.equal(canPick("single", [], DM), false);
  }

  // ── 5. The rep's draft: a chain's second person is a senior manager OR a product manager ─────
  {
    const withPm = parseVisitDraft({ ...DRAFT, kind: "chain", managerHrId: "B-12", productManagerHrId: "PM-1" });
    assert.equal(withPm.ok, true, withPm.ok ? "" : withPm.error);
    if (withPm.ok) {
      assert.equal(withPm.value.kind, "chain");
      assert.equal(withPm.value.managerHrId, "B-12");
      assert.equal(withPm.value.productManagerHrId, "PM-1", "the chain keeps its product manager");
      assert.equal(withPm.value.seniorHrId, null);
    }
    const withSenior = parseVisitDraft({ ...DRAFT, kind: "chain", managerHrId: "B-12", seniorHrId: "A-12" });
    assert.equal(withSenior.ok, true, withSenior.ok ? "" : withSenior.error);
    if (withSenior.ok) assert.equal(withSenior.value.productManagerHrId, null);

    const neither = parseVisitDraft({ ...DRAFT, kind: "chain", managerHrId: "B-12" });
    assert.equal(neither.ok, false, "a chain with nobody beside the manager is still refused");
    assert.equal(neither.ok ? "" : neither.error, "Choose who else was on the chain visit.");

    // A double still drops a stray product manager: it is the district managers' figure.
    const double = parseVisitDraft({ ...DRAFT, kind: "double", managerHrId: "B-12", productManagerHrId: "PM-1" });
    assert.equal(double.ok && double.value.productManagerHrId, null);
  }

  // ── 6. The Super Admin's correction, off the wire ─────────────────────────────────────────────
  {
    const ok = parseVisitEdit({ visitId: VISIT_ID.toUpperCase(), who: null, products: ["Saginko", "Saginko", " Daflon "], comment: "  Corrected  " });
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
    if (ok.ok) {
      assert.deepEqual(ok.value, { visitId: VISIT_ID, who: null, products: ["Saginko", "Daflon"], comment: "Corrected" }, "no who on the wire = who is left exactly as recorded");
    }
    const changed = parseVisitEdit({ visitId: VISIT_ID, who: { choice: "chain", picked: ["B-12", "PM-1"] }, products: ["Saginko"], comment: "Fixed" });
    assert.equal(changed.ok && changed.value.who?.choice, "chain");

    const refused = (raw: unknown) => {
      const result = parseVisitEdit(raw);
      assert.equal(result.ok, false);
      return result.ok ? "" : result.error;
    };
    refused({ visitId: "not-a-visit", who: null, products: ["Saginko"], comment: "x" });
    refused({ visitId: VISIT_ID, who: { choice: "triple", picked: [] }, products: ["Saginko"], comment: "x" });
    assert.equal(
      refused({ visitId: VISIT_ID, who: { choice: "double", picked: ["B-12", "A-12"] }, products: ["Saginko"], comment: "x" }),
      "Choose who was on the visit.",
      "two ticks under Double is a form that lost track of itself — refused, never trimmed to a guess",
    );
    assert.equal(refused({ visitId: VISIT_ID, who: null, products: [], comment: "x" }), "Choose the products discussed.");
    assert.match(refused({ visitId: VISIT_ID, who: null, products: Array.from({ length: 13 }, (_, index) => `P${index}`), comment: "x" }), /at most 12/);
    refused({ visitId: VISIT_ID, who: null, products: ["Saginko"], comment: "   " });
    refused({ visitId: VISIT_ID, who: null, products: ["Saginko"], comment: "x".repeat(1001) });
    refused(null);
  }

  // ── 7. Whose people can be changed ────────────────────────────────────────────────────────────
  {
    assert.deepEqual(visitWhoEditable({ repHrId: "B-7", enteredByHrId: "b-7", captureSource: "server" }), { editable: true }, "a visit the rep entered himself");
    assert.deepEqual(visitWhoEditable({ repHrId: "B-7", enteredByHrId: "S-1", captureSource: "admin" }), { editable: true }, "a visit the Super Admin entered for him");
    assert.deepEqual(
      visitWhoEditable({ repHrId: "B-7", enteredByHrId: "B-12", captureSource: "server" }),
      { editable: false, reason: VISIT_PEOPLE_FIXED_MANAGER_ENTRY },
      "a manager's own entry keeps its people — otherwise it would read as entered by somebody who was not on it",
    );
    assert.deepEqual(visitWhoEditable({ repHrId: null, enteredByHrId: "B-12", captureSource: "server" }), { editable: false, reason: VISIT_PEOPLE_FIXED_NO_REP });
  }

  // ── 8. The fences, read off the code and the migration ────────────────────────────────────────
  {
    // The Super Admin's alone, asserted at the route AND in the service.
    const route = source("app/api/phoenix-crm/visit-edit/route.ts");
    assert.equal(route.match(/assertPermission\(access, "phoenix_crm", "update"\)/g)?.length, 2, "GET and POST both assert update");
    assert.match(route, /assertSameOriginMutation\(request\)/);
    const access = source("src/lib/phoenix-crm/server/access.ts");
    assert.match(access, /export function territoryForVisitEdit\([^)]*\): TerritoryAccess \{\s*if \(!canEnterMissedRecords\(viewer\)\) throw forbiddenError\(/);

    // It re-checks every person the way the rep's own save does, and it never writes a table itself.
    const service = source("src/lib/phoenix-crm/server/visit-edit.ts");
    assert.match(service, /resolveVisitParticipants\(\{[^}]*enteredAs: "rep"/, "the people go through the SAME resolver, as the rep");
    assert.match(service, /visitWhoEditable\(/);
    assert.match(service, /callPhoenixCrm<Row>\("phoenix_crm_admin_edit_visit"/);
    assert.doesNotMatch(service, /\.(?:insert|update|upsert|delete)\(/, "the one writer is the database function");
    assert.doesNotMatch(service, /notifications|sendEmail|telegram|logAudit|enqueue/i, "the rep is told nothing — Golden Rule #1");

    // The screen is drawn from the server's own answer, per visit.
    assert.match(source("src/lib/phoenix-crm/server/day-detail.ts"), /editsVisits: canEnterMissedRecords\(viewer\),/);
    assert.match(source("src/components/phoenix-crm/day-detail-view.tsx"), /view\.editsVisits \? <EditVisit /);

    // The rep's form offers Single / Double / Chain from ONE list and files it through the shared rule.
    const form = source("src/components/phoenix-crm/visit-log-form.tsx");
    assert.match(form, /companyToStorage\(\{ choice: choiceOf\(kind\), offers: who\.offers, picked \}\)/);
    assert.match(form, /<CompanyPicker/);
    assert.doesNotMatch(form, /label: "A product manager"/, "a product manager is a person on the list, not a fourth kind the rep has to know");
    assert.doesNotMatch(form, /value: "product_manager"/, "a rep is never offered the product-manager kind");

    // The migration: shape, writer, audit copy, and a correction that can only touch three things.
    const migration = stripSqlComments(read("supabase/migrations/20261006234611_phoenix_crm_visit_company_and_admin_edit.sql"));
    assert.match(migration, /create table if not exists public\.phoenix_crm_visit_edits/);
    assert.match(migration, /alter table public\.phoenix_crm_visit_edits enable row level security;/);
    assert.match(migration, /revoke all on table public\.phoenix_crm_visit_edits from public, anon, authenticated;/);
    assert.match(migration, /revoke execute on function public\.phoenix_crm_admin_edit_visit\(jsonb\) from public, anon, authenticated;/);
    assert.match(migration, /grant execute on function public\.phoenix_crm_admin_edit_visit\(jsonb\) to service_role;/);
    // No foreign key on the audit copy: removing a visit must not be blocked by, or delete, its history.
    assert.doesNotMatch(migration.slice(migration.indexOf("create table if not exists public.phoenix_crm_visit_edits")).split(");")[0], /references/i);
    // The copy is written BEFORE the visit is changed.
    const copyAt = migration.indexOf("insert into public.phoenix_crm_visit_edits");
    const overwriteAt = migration.search(/update public\.phoenix_crm_visits\s+set kind = v_new_kind/);
    assert.ok(copyAt > 0 && overwriteAt > copyAt, "the copy is kept before the visit is overwritten");
    assert.match(migration, /raise exception 'phoenix_crm:visit_people_fixed';/);

    // 🔴 EVERY visit UPDATE in the function names only the three things (plus the linked pharmacy visits'
    // products). The evidence — customer, day, time, place, photo, voice — is never in a `set`.
    const sets = [...migration.matchAll(/update public\.phoenix_crm_visits\s+set([\s\S]*?)\swhere /g)].map((match) => match[1]);
    assert.equal(sets.length, 2, "the visit itself, and the pharmacy visits it filed");
    for (const set of sets) {
      assert.doesNotMatch(set, /customer_id|visit_date|captured_at|photo|voice|\blat\b|\blon\b|place_id|location_flag|distance|capture_source|entered_by|rep_hr_id|is_test|seat_id/, "a correction never touches the evidence");
    }
    assert.match(sets[0], /kind = v_new_kind,[\s\S]*manager_hr_id = v_new_manager,[\s\S]*senior_hr_id = v_new_senior,[\s\S]*product_manager_hr_id = v_new_product_manager,[\s\S]*products = v_products,[\s\S]*comment = v_comment/);
  }

  console.log("phoenix-crm visit company and admin edit: OK");
}
