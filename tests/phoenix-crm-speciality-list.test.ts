import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyCrmContactSpeciality } from "../src/lib/crm/contact-taxonomy.ts";
import {
  ACCOUNT_SPECIALITIES,
  CUSTOMER_TYPES,
  DOCTOR_SPECIALITIES,
  PHARMACY_SPECIALITY,
  customerKindMissing,
  customerKindProblem,
  customerKindText,
  customerTypeChoices,
  isListedCustomerType,
  isListedSpeciality,
  normalizeSpeciality,
  specialityChoices,
  splitCustomerKind,
} from "../src/lib/phoenix-crm/speciality-list.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A Phoenix CRM customer's speciality is PICKED from one fixed list, and only "Other" is typed (owner,
 * 2026-11-19: *"fix specialities and fix this chaos and make the speciality not typable fixed drop
 * list"*, then *"add other and under other make him able to type"*).
 *
 * ## Why this exists
 *
 * The audit that morning found 111 spellings for about thirty specialities on 21,966 live customers —
 * "Pedia", "pedia", "Pediatric", "اطفال", "بيديا", and a "pedia" carrying an invisible right-to-left
 * mark were six customers' worth of one speciality — and 444 of the 2,561 doctors a rep had added
 * himself carried one, against 21 of the 9,018 brought from the old CRM. The cause was the field: a
 * text box with a suggestion list ("Pick one from the list or write it").
 *
 * Pinned here, each by behaviour where it can be:
 *
 *   1. **The production clean-up and the server's normaliser are ONE answer.** Every `(raw, clean)`
 *      pair in migration `20261119144643` is read out of the file and handed to
 *      `normalizeSpeciality` — so a later edit to the alias table that would have cleaned production
 *      differently goes red here, and so does a hand edit to the migration.
 *   2. **What spells nothing on the list is kept as written** — that is the "Other" he asked for —
 *      and an empty box or a bare ".." is no speciality at all.
 *   3. **The list itself**: every name on it folds to itself, a rep's AM/PM list never offers
 *      Pharmacy (a pharmacy has its own list type), a manager's own list does, and neither group's
 *      label says doctor or account (the retired names of PM and AM).
 *   4. **Every door goes through it**: the three screens draw `CrmCustomerKindField` (no free-text
 *      suggestion box), and the server paths that write a speciality fold it first.
 *   5. **The type apart from the speciality** (owner, the same afternoon: *"hospital is not a speciality
 *      .. clinic, example pedia"*; then by multiple choice: only a clinic or a polyclinic needs one).
 *      `splitCustomerKind` and the database's `phoenix_crm_split_customer_kind` (migration
 *      `20261119151229`) are one rule: the SQL arrays are read out of the file and held to the TS lists,
 *      and the cases below are the rule's truth table.
 */
export function runPhoenixCrmSpecialityListTests() {
  // ── 1. The migration's pairs are the normaliser's own answers ──────────────────────────────────
  const migration = readFileSync(
    new URL("../supabase/migrations/20261119144643_phoenix_crm_speciality_one_list.sql", import.meta.url),
    "utf8",
  );
  const pairLine = /^\s+\((U&)?'([^']*)', (?:null::text|'([^']*)')\)[,;]?\s*$/;
  const decode = (escaped: boolean, text: string) =>
    escaped ? text.replace(/\\([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) : text;
  const pairs = migration
    .split(/\r?\n/)
    .map((line) => pairLine.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ raw: decode(Boolean(match[1]), match[2]), clean: match[3] ?? null }));

  assert.equal(pairs.length, 88, "the migration folds the 88 spellings production held on 2026-11-19");
  for (const { raw, clean } of pairs) {
    assert.equal(normalizeSpeciality(raw), clean, `the server folds ${JSON.stringify(raw)} exactly as production was cleaned`);
  }
  assert.ok(
    pairs.some(({ raw }) => raw.startsWith("‏")),
    "a spelling carrying a hidden right-to-left mark is among the pairs, decoded to the real character",
  );

  // Spot checks a reader can see at a glance.
  assert.equal(normalizeSpeciality("بيديا"), "Pediatrics");
  assert.equal(normalizeSpeciality("‏Neuro"), "Neurology", "a hidden direction mark is not part of the speciality");
  assert.equal(normalizeSpeciality("Pedia + IM"), "Pediatrics", "two specialities in one box keep the first one named");
  assert.equal(normalizeSpeciality("باطنه وقلب"), "Internal Medicine", "the Arabic 'and' splits a combined box too");
  assert.equal(normalizeSpeciality("  internal   medicine "), "Internal Medicine", "case and spacing never make a new speciality");

  // ── 2. "Other" passes through; nothing is no speciality ───────────────────────────────────────
  for (const other of ["Distributor", "Store", "Bank", "النووية"]) {
    assert.equal(normalizeSpeciality(other), other, `${other} spells nothing on the list, so it stays as an Other speciality`);
  }
  for (const empty of [null, undefined, "", "   ", ".."]) {
    assert.equal(normalizeSpeciality(empty), null, `${JSON.stringify(empty)} is no speciality`);
  }

  // ── 3. The list ───────────────────────────────────────────────────────────────────────────────
  for (const name of [...DOCTOR_SPECIALITIES, ...ACCOUNT_SPECIALITIES, PHARMACY_SPECIALITY]) {
    assert.equal(normalizeSpeciality(name), name, `${name} is already the list's own name`);
  }
  // The one authority on doctor-versus-place (crm/contact-taxonomy.ts) must agree with the two groups,
  // or cleaning a speciality would move a customer between the doctor and the place buckets.
  for (const name of DOCTOR_SPECIALITIES) {
    assert.equal(classifyCrmContactSpeciality(name), "sp", `${name} is a doctor to the contact taxonomy too`);
  }
  for (const name of [...ACCOUNT_SPECIALITIES, PHARMACY_SPECIALITY]) {
    assert.equal(classifyCrmContactSpeciality(name), "hcp", `${name} is a place or an account to the contact taxonomy too`);
  }
  // Since the split the Speciality list is the medical specialities ONLY, on every list: a place, an
  // account or a pharmacy is a TYPE.
  for (const kind of ["AM", "PM", "manager", "Pharmacy"] as const) {
    assert.deepEqual(specialityChoices(kind).flatMap((group) => group.items), [...DOCTOR_SPECIALITIES], `the ${kind} Speciality list is the medical specialities`);
    for (const place of [...ACCOUNT_SPECIALITIES, PHARMACY_SPECIALITY]) {
      assert.equal(isListedSpeciality(place, kind), false, `${place} is never a speciality on the ${kind} list`);
    }
  }
  assert.equal(isListedCustomerType(PHARMACY_SPECIALITY, "AM"), false, "a rep's AM list never offers the Pharmacy type");
  assert.equal(isListedCustomerType(PHARMACY_SPECIALITY, "PM"), false, "a rep's PM list never offers the Pharmacy type");
  assert.equal(isListedCustomerType(PHARMACY_SPECIALITY, "manager"), true, "a manager's own list offers the Pharmacy type");
  assert.deepEqual(
    new Set(customerTypeChoices("manager").flatMap((group) => group.items)),
    new Set<string>(CUSTOMER_TYPES),
    "a manager's Type list is every type, no more and no less",
  );
  assert.equal(customerTypeChoices("AM")[0].label, "Hospitals", "an AM list opens on the hospitals");
  assert.equal(customerTypeChoices("PM")[0].label, "Clinics", "a PM list opens on the clinics");
  for (const kind of ["AM", "PM", "manager"] as const) {
    for (const group of [...specialityChoices(kind), ...customerTypeChoices(kind)]) {
      assert.doesNotMatch(group.label, /\b(doctors?|accounts?)\b/i, `the ${kind} group "${group.label}" never says doctor or account`);
    }
  }

  // ── 4. Every door goes through it ─────────────────────────────────────────────────────────────
  const source = (path: string) => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  for (const screen of [
    "src/components/phoenix-crm/list-screens.tsx",
    "src/components/phoenix-crm/out-of-list-entry.tsx",
    "src/components/phoenix-crm/manager-customer-form.tsx",
  ]) {
    const text = source(screen);
    assert.ok(text.includes("<CrmCustomerKindField"), `${screen} draws the one type and speciality pick-lists`);
    assert.ok(text.includes("customerKindProblem("), `${screen} refuses a clinic left without its speciality before it posts`);
    assert.ok(!text.includes("write it"), `${screen} no longer invites a typed speciality`);
  }
  assert.ok(source("src/lib/phoenix-crm/list-template-rules.ts").includes("normalizeSpeciality("), "the list template folds the speciality");
  for (const writer of [
    "src/lib/phoenix-crm/entry-rules.ts",
    "src/lib/phoenix-crm/server/list.ts",
    "src/lib/phoenix-crm/server/manager-customers.ts",
  ]) {
    assert.ok(source(writer).includes("splitCustomerKind("), `${writer} splits the type from the speciality before it is saved`);
  }
  // The visit form asks a rep for a missing one before the visit, through the same field.
  const gate = source("src/components/phoenix-crm/visit-kind-gate.tsx");
  assert.ok(gate.includes("<CrmCustomerKindField") && gate.includes("kindOnly: true"), "the visit gate picks from the same lists and saves only the kind");
  const visitsTab = source("src/components/phoenix-crm/visits-tab.tsx");
  assert.match(visitsTab, /customer\.kindMissing && loaded\.enteredAs === "rep"/, "only the territory's own rep is asked, and only for a customer who owes it");

  // ── 5. The type apart from the speciality ─────────────────────────────────────────────────────
  const split = readFileSync(
    new URL("../supabase/migrations/20261119151229_phoenix_crm_customer_type_apart_from_speciality.sql", import.meta.url),
    "utf8",
  );
  const sqlArray = (name: string) => {
    const match = new RegExp(`${name} constant text\\[\\] := array\\[([^\\]]*)\\]`).exec(split);
    assert.ok(match, `the migration declares ${name}`);
    return [...match[1].matchAll(/'([^']*)'/g)].map((item) => item[1]);
  };
  assert.deepEqual(sqlArray("v_medical"), [...DOCTOR_SPECIALITIES], "the database's medical list is the screen's list, in order");
  assert.deepEqual(
    sqlArray("v_places"),
    CUSTOMER_TYPES.filter((type) => type !== "Clinic" && type !== "Polyclinic"),
    "the database's place and account types are the screen's, in order",
  );

  type Kind = { customerType: string | null; speciality: string | null };
  const cases: Array<[string, { customerType?: string | null; speciality?: string | null; listType?: string | null }, Kind]> = [
    ["a hospital in the speciality box becomes the type", { speciality: "Hospital", listType: "AM" }, { customerType: "Hospital", speciality: null }],
    ["Polyclinics in the old box is a Polyclinic type", { speciality: "Polyclinics", listType: "AM" }, { customerType: "Polyclinic", speciality: null }],
    ["a PM doctor with nothing is a clinic still owing his speciality", { listType: "PM" }, { customerType: "Clinic", speciality: null }],
    ["a medical speciality alone means a clinic", { speciality: "pedia", listType: "AM" }, { customerType: "Clinic", speciality: "Pediatrics" }],
    ["an AM customer with nothing has no type yet", { listType: "AM" }, { customerType: null, speciality: null }],
    ["a pharmacy list row is a Pharmacy with no speciality", { speciality: "Pediatrics", listType: "Pharmacy" }, { customerType: "Pharmacy", speciality: null }],
    ["a hospital drops a speciality sent with it", { customerType: "Hospital", speciality: "ENT", listType: "AM" }, { customerType: "Hospital", speciality: null }],
    ["a polyclinic keeps its speciality", { customerType: "polyclinic", speciality: "ENT", listType: "AM" }, { customerType: "Polyclinic", speciality: "ENT" }],
    ["a typed Other type is kept as written", { customerType: "Medical Centre", listType: "AM" }, { customerType: "Medical Centre", speciality: null }],
    ["Pharmacy in a doctor's list box is the Pharmacy type", { speciality: "Pharmacy", listType: "PM" }, { customerType: "Pharmacy", speciality: null }],
    ["a picked Clinic with a place in the box takes the place", { customerType: "Clinic", speciality: "Contract", listType: "AM" }, { customerType: "Contract", speciality: null }],
  ];
  for (const [label, input, expected] of cases) {
    assert.deepEqual(splitCustomerKind(input), expected, label);
  }

  assert.equal(customerKindMissing({ customerType: "Pharmacy", speciality: null, listType: "Pharmacy" }), false, "a pharmacy owes nothing");
  assert.equal(customerKindMissing({ customerType: "Hospital", speciality: null, listType: "AM" }), false, "a hospital owes no speciality");
  assert.equal(customerKindMissing({ customerType: "Clinic", speciality: null, listType: "PM" }), true, "a clinic owes its speciality");
  assert.equal(customerKindMissing({ customerType: null, speciality: null, listType: "AM" }), true, "a customer with no type owes it");
  assert.equal(customerKindProblem({ customerType: "", speciality: "", listType: "AM" }), "Pick the type first.");
  assert.equal(customerKindProblem({ customerType: "Clinic", speciality: "", listType: "PM" }), "Pick the speciality first.");
  assert.equal(customerKindProblem({ customerType: "Private Hospital", speciality: "", listType: "AM" }), null, "a hospital needs no speciality");
  assert.equal(customerKindProblem({ customerType: "", speciality: "", listType: "Pharmacy" }), null, "a pharmacy is never asked");
  assert.equal(customerKindText("Clinic", "Pediatrics"), "Pediatrics", "a clinic prints its speciality");
  assert.equal(customerKindText("Polyclinic", "ENT"), "Polyclinic · ENT");
  assert.equal(customerKindText("Hospital", null), "Hospital", "a hospital prints its type where the speciality used to say it");
  assert.equal(customerKindText(null, null), null);
}
