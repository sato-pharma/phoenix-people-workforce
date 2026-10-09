import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  parseCustomerPhone,
  parsePharmacyPin,
  PLACE_MAX_ACCURACY_METERS,
  ROUGH_PIN_AT_THE_PHARMACY,
  VISIT_MAX_ACCURACY_METERS,
} from "../src/lib/phoenix-crm/entry-rules.ts";

/**
 * Phoenix CRM — a pharmacy's own location, and its responsible person's phone (owner, 2026-10-09:
 * "visiting pharmacy or adding a new pharmacy — make it optional to add its location by a pin button
 * … optional, if you want to save its location do this; if you want, also don't do this. And also
 * make optional to add the responsible person's phone number. And of course, when he captured the
 * location, the location is then cleaned and separated into area, brick, governorate").
 *
 * What this pins:
 *
 *   1. BOTH ARE OPTIONAL, AND OPTIONAL MEANS NEVER A REFUSAL. A pharmacy saved by its name alone takes
 *      exactly the taps it took before: an absent pin, an empty pin object and an empty phone are all
 *      `null` and never an error. The ONE thing that refuses is a reading too rough to be a place.
 *   2. THE GEOGRAPHY IS RESOLVED, NEVER TYPED. The pin goes through the SAME resolver a doctor's
 *      validated place uses, so a pharmacy and a clinic can never disagree about the brick a point
 *      falls in, and the governorate is Google's own component — never guessed from the address text.
 *   3. 🔴 THE PIN IS A RECORD, NOT A CHECK. A pharmacy needs no validation (owner, 2026-10-03) and this
 *      changes nothing about that: no visit is measured against the pin, nothing is flagged far from
 *      it, no approval waits on it and no KPI reads it. Golden rule #1 — the rep's own screens carry
 *      WHERE and never HOW WELL: no accuracy, no brick distance.
 *   4. ADD FILLS ONLY WHAT IS EMPTY; CORRECTING IS THE OTHER FUNCTION. An add meant as an add never
 *      overwrites a pin or a phone already on file. `phoenix_crm_set_pharmacy_details` is the
 *      correction path, where a named key means "set it" and an absent key means "leave it".
 *   5. ONE SELECT STRING, THIRTEEN COLUMNS. A PostgREST select is one string and a column that does not
 *      exist fails the WHOLE read with 42703 — here the rep's list, the planner and the visit form at
 *      once. The same `CUSTOMER_COLUMNS` feeds the List and the visit picker, so it names all thirteen.
 */

const source = (path: string) => stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
const raw = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const MIGRATION = "supabase/migrations/20261010010000_phoenix_crm_pharmacy_pin_and_phone.sql";

/** The thirteen columns the pin and its resolved geography live in. */
const PIN_COLUMNS = [
  "pharmacy_pin_lat",
  "pharmacy_pin_lon",
  "pharmacy_pin_accuracy_meters",
  "pharmacy_pin_captured_at",
  "pharmacy_pin_captured_by_hr_id",
  "pharmacy_pin_address",
  "pharmacy_pin_governorate",
  "pharmacy_pin_area_code",
  "pharmacy_pin_area_name",
  "pharmacy_pin_brick_id",
  "pharmacy_pin_brick_name",
  "pharmacy_pin_brick_distance_km",
  "pharmacy_pin_brick_lookup",
];

/** The words Golden rule #1 keeps off a rep's own screen — the same list the field-reach test uses. */
const JUDGING_WORDS = [/distance/i, /accuracy/i, /\bfar\b/i, /spread/i, /integrity/i, /\bflagg?ed\b/i, /suspic/i];

/** A pin body as the phone sends it. */
function captured(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { lat: 30.0444196, lon: 31.2357116, accuracyMeters: 12, deviceCapturedAt: "2026-10-09T10:00:00.000Z", ...extra };
}

export function runPhoenixCrmPharmacyPinTests() {
  // ── 1. Optional means never a refusal ─────────────────────────────────────────────────────────
  {
    for (const [label, body] of [
      ["absent", undefined],
      ["null", null],
      ["an empty object", {}],
      ["a body naming neither coordinate", { accuracyMeters: 9 }],
    ] as Array<[string, unknown]>) {
      const result = parsePharmacyPin(body);
      assert.ok(result.ok, `${label} is him choosing not to pin it, never an error`);
      assert.equal(result.ok && result.value, null, `${label} carries no pin`);
    }

    const pinned = parsePharmacyPin(captured());
    assert.ok(pinned.ok, "a usable reading at the pharmacy is kept");
    assert.deepEqual(
      pinned.ok ? pinned.value : null,
      { lat: 30.0444196, lon: 31.2357116, accuracyMeters: 12, capturedAt: "2026-10-09T10:00:00.000Z" },
      "the point, how rough the phone said it was, and the phone's own clock — nothing else",
    );

    // The ONE refusal: a reading too rough to be a place at all. The module's own wider line, the
    // same 500 m a visit is allowed, because a rep standing inside a shop is not at a signboard.
    // 🔴 THE LINE IS THE OWNER'S OWN, CONFIRMED 2026-10-09 ("keep the 500 m limit on a pharmacy
    // pin") when he was asked whether a pin should instead be held to a validated place's 250 m. A
    // session reading the two limits as an inconsistency must not tighten this one: the refusal
    // exists only so a phone on APPROXIMATE location (a flat ~2,000 m) cannot write a brick the rep
    // is not standing in, and it never blocks the save.
    assert.equal(
      VISIT_MAX_ACCURACY_METERS,
      500,
      "the module's wider accuracy line, and the owner's own confirmed choice for a pharmacy pin (2026-10-09) — never a validated place's 250 m",
    );
    assert.notEqual(
      VISIT_MAX_ACCURACY_METERS,
      PLACE_MAX_ACCURACY_METERS,
      "a pharmacy pin is deliberately NOT held to the line a validated place is held to",
    );
    assert.ok(parsePharmacyPin(captured({ accuracyMeters: 500 })).ok, "500 m is inside the line");
    const rough = parsePharmacyPin(captured({ accuracyMeters: 900 }));
    assert.ok(!rough.ok, "and 900 m is not a pharmacy's place");
    assert.ok(rough.ok === false && rough.error.includes("save the pharmacy without it"), "the refusal offers the way past it: save the pharmacy anyway");
    assert.ok(ROUGH_PIN_AT_THE_PHARMACY.includes("save the pharmacy without it"), "and so does the message for a phone that reported nothing at all");

    // A phone that said nothing about how rough its reading was is NOT refused — "unknown" is not
    // "bad", and refusing it would cost a rep the pin on every phone that does not report accuracy.
    assert.ok(parsePharmacyPin(captured({ accuracyMeters: null })).ok, "an unknown accuracy still pins");
    assert.ok(parsePharmacyPin(captured({ accuracyMeters: "" })).ok, "and so does a blank one");

    // Not a place: (0, 0) and a point outside Egypt's field range are refused the same way a visit's
    // reading is, through the one shared `isUsableFix`.
    for (const body of [captured({ lat: 0, lon: 0 }), captured({ lat: 48.8566, lon: 2.3522 }), captured({ lat: "north" }), "a pin"]) {
      assert.ok(!parsePharmacyPin(body).ok, "a reading that is not a place in Egypt is refused");
    }

    // Golden rule #1: what he reads back is about his PHONE, never about him.
    for (const word of [/\byou are\b/i, /\btoo far\b/i, /suspic/i, /integrity/i]) {
      assert.doesNotMatch(ROUGH_PIN_AT_THE_PHARMACY, word, "the refusal names the phone, never the rep");
    }
  }

  // ── 2. The phone: optional, and emptying the box clears it ────────────────────────────────────
  {
    assert.deepEqual(parseCustomerPhone(undefined), { ok: true, value: null }, "no phone is not an error");
    assert.deepEqual(parseCustomerPhone(""), { ok: true, value: null }, "and an emptied box clears it");
    assert.deepEqual(parseCustomerPhone("   "), { ok: true, value: null });
    assert.deepEqual(parseCustomerPhone("0100 123 4567"), { ok: true, value: "01001234567" }, "spaces are dropped, so the box reads as he typed it");
    assert.deepEqual(parseCustomerPhone("٠١٠٠١٢٣٤٥٦٧"), { ok: true, value: "01001234567" }, "Arabic-Indic digits are his digits");
    assert.deepEqual(parseCustomerPhone("00201001234567"), { ok: true, value: "+201001234567" }, "a 00 dialled prefix is the + the check expects");
    assert.equal(parseCustomerPhone("call the pharmacy").ok, false, "and words are not a phone number");
  }

  // ── 3. The migration: thirteen nullable columns, two functions, expand-only ───────────────────
  {
    const sql = raw(MIGRATION);
    const body = sql.slice(sql.indexOf("begin;"));

    for (const column of PIN_COLUMNS) {
      assert.ok(body.includes(`add column if not exists ${column} `), `${column} is added, and guarded by if not exists`);
    }
    // Nullable and undefaulted, read off the ALTER itself: a pharmacy with none of them behaves
    // exactly as it does today, and a default would have written a value onto every customer row.
    const addColumns = body.slice(body.indexOf("alter table public.phoenix_crm_customers"), body.indexOf(";", body.indexOf("add column if not exists pharmacy_pin_brick_lookup")));
    assert.doesNotMatch(addColumns, /not null/i, "every one of them is nullable");
    assert.doesNotMatch(addColumns, /\bdefault\b/i, "and none of them carries a default");
    assert.doesNotMatch(body, /drop column/i, "expand-only: nothing is dropped in the migration body");
    assert.doesNotMatch(body, /drop table|truncate|delete from/i, "and it writes no rows at all");

    // The three checks, each guarded by name because `add constraint if not exists` does not exist.
    assert.ok(body.includes("check ((pharmacy_pin_lat is null) = (pharmacy_pin_lon is null))"), "half a coordinate is not a pin");
    assert.ok(
      body.includes("check (pharmacy_pin_lat is null or list_type = 'Pharmacy')"),
      "a pin belongs to a PHARMACY — a doctor's location is a validated place with a photo, never this column",
    );
    assert.ok(
      body.includes("check (pharmacy_pin_brick_lookup is null or pharmacy_pin_brick_lookup in ('matched', 'none_nearby', 'could_not_look'))"),
      "the three answers the brick lookup can give, kept apart: 'we could not look' is not 'nothing is near'",
    );
    for (const name of [
      "phoenix_crm_customers_pharmacy_pin_pair",
      "phoenix_crm_customers_pharmacy_pin_is_a_pharmacy",
      "phoenix_crm_customers_pharmacy_pin_brick_lookup",
    ]) {
      assert.ok(body.includes(`conname = '${name}'`), `${name} is guarded by name, so re-applying the migration is safe`);
    }

    // Add a pharmacy: same signature, same answer, and what he captured fills only what is EMPTY.
    assert.ok(body.includes("create or replace function public.phoenix_crm_add_pharmacy(p jsonb)"), "the same signature — no caller has to change");
    assert.ok(body.includes("v_phone !~ '^\\+?[0-9]{7,15}$'"), "the phone is checked in the database too, not only in the app");
    assert.ok(
      body.includes("case when v_phone is not null and c.phone is null then v_phone else c.phone end"),
      "a phone already on the pharmacy survives an add — an add is not a correction",
    );
    assert.ok(
      body.includes("case when v_pin is not null and c.pharmacy_pin_lat is null then (v_pin ->> 'lat')::double precision else c.pharmacy_pin_lat end"),
      "and so does a pin already on it",
    );

    // Correcting one: the KEY is what says "set it", so a caller one release behind changes nothing.
    assert.ok(body.includes("create or replace function public.phoenix_crm_set_pharmacy_details(p jsonb)"), "the correction path is its own function");
    assert.ok(body.includes("v_sets_phone boolean := (p -> 'phone') is not null;"), "a named phone key means set it — null included, which is how it is cleared");
    assert.ok(body.includes("v_sets_pin boolean := (p -> 'pin') is not null;"), "and a named pin key means set it");
    assert.ok(body.includes("not (v_sets_phone or v_sets_pin)"), "a body naming neither is refused rather than writing nothing");
    for (const refusal of ["phoenix_crm:not_a_pharmacy", "phoenix_crm:customer_not_found", "phoenix_crm:customer_dropped", "phoenix_crm:bad_phone"]) {
      assert.ok(body.includes(refusal), `${refusal} is answered by name`);
    }
    assert.ok(body.includes("'pharmacy_details_set'"), "every correction leaves a list event behind it");
    assert.ok(body.includes("'from', v_before"), "with what it was, not only what it became");

    // Neither function is reachable from a browser: the service role calls them, and nobody else.
    for (const fn of ["phoenix_crm_add_pharmacy", "phoenix_crm_set_pharmacy_details"]) {
      assert.ok(body.includes(`revoke execute on function public.${fn}(jsonb) from public, anon, authenticated;`), `${fn} is revoked from every browser role`);
      assert.ok(body.includes(`grant execute on function public.${fn}(jsonb) to service_role;`), `${fn} is granted to the service role alone`);
    }
    assert.ok(body.includes("notify pgrst, 'reload schema'"), "PostgREST is told, or the new columns answer 42703 until it restarts");

    // 🔴 A RECORD, NOT A CHECK. Nothing here measures a visit, flags one, or waits for an approval.
    for (const word of [/approve/i, /approval/i, /\bflagg?ed\b/i, /integrity/i, /within_meters/i, /too_far/i]) {
      assert.doesNotMatch(body, word, "the pin is a record — nothing in the migration measures or gates anything on it");
    }
  }

  // ── 4. The server: one resolver for a clinic and a pharmacy alike ─────────────────────────────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");

    // The SAME function resolves a doctor's validated place and a pharmacy's pin. Two resolvers would
    // let a pharmacy and the clinic across the street disagree about which brick the street is in.
    assert.ok(list.includes("async function resolvePinGeography("), "one shared resolver");
    assert.equal((list.match(/await resolvePinGeography\(/g) ?? []).length, 2, "and exactly two callers: the validated place, and the pharmacy pin");
    assert.ok(list.includes("const geo = await resolvePinGeography(pin);"), "the pharmacy pin is resolved through it");
    assert.ok(list.includes("const geo = await resolvePinGeography(point);"), "and so is the place");

    // The governorate is Google's own component, never read out of the address line: a street or
    // district name reads like a governorate, and a wrong one on a pharmacy is worse than none.
    assert.ok(list.includes("governorate: located?.components.governorate ?? null,"), "the governorate comes from the geocode's components");
    assert.doesNotMatch(list, /governorate[^\n]*address\.split|split[^\n]*governorate/i, "and is never cut out of the address text");

    // What the pin writes: the thirteen fields, snake_case, as the function expects them.
    const payload = list.slice(list.indexOf("async function resolvePharmacyPinPayload("));
    for (const key of ["lat:", "lon:", "accuracy_meters:", "captured_at:", "address: geo.address", "governorate: geo.governorate", "area_code:", "area_name:", "brick_id:", "brick_name:", "brick_distance_km:", "brick_lookup:"]) {
      assert.ok(payload.slice(0, payload.indexOf("}")).includes(key), `the pin payload names ${key}`);
    }

    // The key-presence contract, mirrored on this side of the wire.
    assert.ok(list.includes('const setsPhone = "phone" in body;'), "a named phone key means set it");
    assert.ok(list.includes('const setsPin = "pin" in body;'), "a named pin key means set it");
    assert.ok(list.includes("if (!setsPhone && !setsPin) throw validationError("), "and a body naming neither is refused before the call");

    // One select string, thirteen columns — and it feeds the List AND the visit picker, which is why
    // a column missing from it is the rep's list, his planner and his visit form at once.
    const columns = list.slice(list.indexOf("const CUSTOMER_COLUMNS ="), list.indexOf("async function", list.indexOf("const CUSTOMER_COLUMNS =")));
    for (const column of PIN_COLUMNS) assert.ok(columns.includes(column), `CUSTOMER_COLUMNS names ${column}`);

    // An unknown brick answer stays null here, deliberately unlike a place's: a place ALWAYS resolved
    // its brick when it was validated, so a blank there means the lookup failed — while a pharmacy
    // pinned by a build older than a column simply never said.
    const mapper = list.slice(list.indexOf("function mapPharmacyPin("));
    assert.ok(mapper.slice(0, mapper.indexOf("\n}")).includes(": null,"), "an unrecognised brick_lookup reads as null, never as could_not_look");

    // 🔴 Golden rule #1 on the rep's picker: WHERE, and never HOW WELL.
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    const picker = visits.slice(visits.indexOf("function pickerPharmacyPin("));
    const pickerBody = picker.slice(0, picker.indexOf("\n}"));
    assert.ok(pickerBody.includes("pharmacy_pin_governorate") && pickerBody.includes("pharmacy_pin_brick_name"), "the picker is told where the pharmacy is");
    assert.ok(
      !pickerBody.includes("pharmacy_pin_accuracy_meters") && !pickerBody.includes("pharmacy_pin_brick_distance_km"),
      "and never how rough the reading was, nor how far from its brick it sits",
    );

    // Nothing anywhere measures a visit against the pin.
    assert.doesNotMatch(visits, /pharmacy_pin_lat[^\n]*(distance|within|flag)/i, "no visit is measured against a pharmacy's pin");
  }

  // ── 5. The route: the territory's own rep, same origin, one permission ────────────────────────
  {
    const route = source("app/api/phoenix-crm/list/pharmacy-details/route.ts");
    assert.ok(route.includes("const csrf = assertSameOriginMutation(request);"), "same-origin first");
    assert.ok(route.includes('await assertPermission(access, "phoenix_crm", "create");'), "then the permission, server-side, before any write");
    assert.ok(route.includes("await setPharmacyDetails(viewer, body)"), "and the service owns the rules");
    const registry = source("src/lib/security/access-registry.ts");
    assert.ok(
      registry.includes('pattern: "/api/phoenix-crm/list/pharmacy-details"') && registry.includes('pattern: "/api/phoenix-crm/list/pharmacy"'),
      "both pharmacy routes are registered, so the access sweep sees them",
    );
  }

  // ── 6. The three screens, and what they send ──────────────────────────────────────────────────
  {
    // Add a pharmacy: the name alone still saves. Neither extra is sent unless he actually gave it.
    const add = source("src/components/phoenix-crm/add-pharmacy.tsx");
    assert.ok(add.includes("...(phone.trim() ? { phone } : {})"), "an untouched phone box is not even sent");
    assert.ok(add.includes("...(pin ? { pin } : {})"), "and neither is a pin he never captured");
    assert.ok(add.includes("<PharmacyExtras"), "both sit under one heading below the name");

    // Correcting them: the phone is ALWAYS named, so emptying the box clears it; the pin is named
    // only when he changed it — a screen that sent `pin: null` on every save would wipe last week's.
    const details = source("src/components/phoenix-crm/pharmacy-details.tsx");
    assert.ok(details.includes("phone,"), "the phone is always named on a correction, which is how it is cleared");
    assert.ok(details.includes("...(pin ? { pin } : removing ? { pin: null } : {})"), "the pin is named only when he captured a new one or asked for it to be removed");
    assert.ok(details.includes('title="Both are optional"'), "and the screen says so in words");

    // 🔴 Golden rule #1 on all three rep screens: no judging word reaches him.
    for (const path of [
      "src/components/phoenix-crm/add-pharmacy.tsx",
      "src/components/phoenix-crm/pharmacy-details.tsx",
      "src/components/phoenix-crm/visit-customer-picker.tsx",
    ]) {
      const code = source(path);
      for (const word of JUDGING_WORDS) assert.doesNotMatch(code, word, `${path} must not carry ${word} to the rep (golden rule #1)`);
    }

    // The Pharmacy visit picker: the strip under a pharmacy's card, on every pharmacy row — the
    // un-pinned one is precisely the one worth offering it to — and on no doctor row.
    const pickerUi = source("src/components/phoenix-crm/visit-customer-picker.tsx");
    assert.ok(pickerUi.includes("const pharmacy = isPharmacyListType(customer.listType);"), "the strip's pharmacy half is keyed off the list type");
    assert.ok(pickerUi.includes("const where = pharmacy ? pharmacyWhereLine(customer.pharmacyPin) : null;"), "a doctor's row is untouched");
    assert.ok(
      pickerUi.includes("const pharmacyDetails = pharmacy && onPharmacyDetails ? () => onPharmacyDetails(customer.customerId) : null;"),
      "and a manager entering a rep's visit is not offered it at all",
    );
    assert.ok(pickerUi.includes("return directionsUrl(place) ?? directionsUrl(customer.pharmacyPin);"), "a pharmacy's pin is what makes Directions work for a pharmacy at all");

    // It is NOT an eighth step in the visit form: it is a screen of the Pharmacy visit flow, reached
    // from the picker, so a rep who wants neither types nothing extra on the visit he came to log.
    const visitsTab = source("src/components/phoenix-crm/visits-tab.tsx");
    assert.ok(visitsTab.includes('{ name: "pharmacy_details"; customerId: string }'), "the details screen is a step of the add flow");
    assert.ok(
      visitsTab.includes('onPharmacyDetails={loaded.enteredAs === "rep" ? (customerId) => onStep({ name: "pharmacy_details", customerId }) : undefined}'),
      "and only the rep himself, standing in the shop, is handed it",
    );
    const form = source("src/components/phoenix-crm/visit-log-form.tsx");
    assert.doesNotMatch(form, /pharmacyPin|pharmacy_details/, "the visit form itself never grew a pin step");
  }
}
