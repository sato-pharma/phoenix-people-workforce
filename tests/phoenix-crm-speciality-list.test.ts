import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyCrmContactSpeciality } from "../src/lib/crm/contact-taxonomy.ts";
import {
  ACCOUNT_SPECIALITIES,
  DOCTOR_SPECIALITIES,
  PHARMACY_SPECIALITY,
  isListedSpeciality,
  normalizeSpeciality,
  specialityChoices,
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
 *   4. **Every door goes through it**: the three screens draw `CrmSpecialityField` (no free-text
 *      suggestion box), and the four server paths that write a speciality call `normalizeSpeciality`.
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
  assert.equal(isListedSpeciality(PHARMACY_SPECIALITY, "AM"), false, "a rep's AM list never offers Pharmacy");
  assert.equal(isListedSpeciality(PHARMACY_SPECIALITY, "PM"), false, "a rep's PM list never offers Pharmacy");
  assert.equal(isListedSpeciality(PHARMACY_SPECIALITY, "manager"), true, "a manager's own list offers Pharmacy");
  assert.equal(specialityChoices("PM")[0].items, DOCTOR_SPECIALITIES, "a PM list opens on the medical specialities");
  assert.equal(specialityChoices("AM")[0].items, ACCOUNT_SPECIALITIES, "an AM list opens on the places and accounts");
  for (const kind of ["AM", "PM", "manager"] as const) {
    for (const group of specialityChoices(kind)) {
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
    assert.ok(text.includes("<CrmSpecialityField"), `${screen} draws the one speciality pick-list`);
    assert.ok(!text.includes("write it"), `${screen} no longer invites a typed speciality`);
  }
  for (const writer of [
    "src/lib/phoenix-crm/entry-rules.ts",
    "src/lib/phoenix-crm/list-template-rules.ts",
    "src/lib/phoenix-crm/server/list.ts",
    "src/lib/phoenix-crm/server/manager-customers.ts",
  ]) {
    assert.ok(source(writer).includes("normalizeSpeciality("), `${writer} folds the speciality before it is saved`);
  }
}
