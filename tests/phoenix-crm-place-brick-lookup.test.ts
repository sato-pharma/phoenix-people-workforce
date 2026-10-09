import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — "did anybody look for this place's brick?" (2026-10-08).
 *
 * A null brick used to mean both "we looked and nothing is within reach" and "the brick master could
 * not be read, so nobody looked" — told apart only by accident. `brick_lookup` says which, the
 * default is the UNKNOWN value so a missed write can never pass for a match, and the field stays with
 * the two readers who see measurements.
 */
export function runPhoenixCrmPlaceBrickLookupTests(): void {
  // `resolvePlaceLocation` moved out of `server/list.ts` into `server/place-location.ts` on
  // 2026-10-09, body unchanged, so a shared place could resolve its point through the SAME function
  // without `list.ts` and `shared-places.ts` importing each other. The reader below follows it; the
  // one thing that must never happen is a second copy of this ternary, which is why it is still
  // asserted as one literal and the List's own column list is still read from `list.ts`.
  const resolver = stripComments(readFileSync("src/lib/phoenix-crm/server/place-location.ts", "utf8"));
  assert.ok(resolver.includes('centroids.length === 0 || brick === null ? "could_not_look" : trusted ? "matched" : "none_nearby"'), "an empty brick master is read as could_not_look, never inferred");
  assert.ok(resolver.includes("brickLookup,"), "the resolver returns the verdict");
  // The verdict is returned by the shared `resolvePinGeography` and mapped onto the column by each
  // writer, so EVERY mapping is asserted: a verdict that reached only one of them would leave the
  // other writing a silent null, which is the whole defect this rule exists to stop. The place
  // mapping sits beside the resolver in `place-location.ts`; the pharmacy's own, which owns that
  // table's column names, stays in `list.ts`. One mapping each — and `list.ts` carries no second
  // copy of the JUDGEMENT, only of the write.
  assert.equal(resolver.split("brick_lookup: geo.brickLookup").length - 1, 1, "the place mapping writes it");
  const list = stripComments(readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8"));
  assert.equal(list.split("brick_lookup: geo.brickLookup").length - 1, 1, "the pharmacy mapping writes it");
  assert.ok(!list.includes('? "could_not_look" :'), "and list.ts carries no second copy of the judgement");
  assert.match(list, /const PLACE_COLUMNS =\s*"[^"]*\bbrick_lookup\b/, "the List reads it");

  const blind = stripComments(readFileSync("src/lib/phoenix-crm/server/blind-payloads.ts", "utf8"));
  const allow = blind.slice(blind.indexOf("export function placeWithoutMeasurements"), blind.indexOf("export function blindTerritoryList"));
  assert.ok(allow.length > 0, "the allow-list could not be located");
  assert.ok(!allow.includes("brickLookup"), "it is a measurement, so it is withheld below the Super Admin and the SFE Manager");
  assert.ok(!allow.includes("brickDistanceKm"), "beside the distance it explains");

  const columns = readFileSync("supabase/migrations/20261008023051_phoenix_crm_signboard_and_capture_trust.sql", "utf8");
  assert.match(columns, /check \(brick_lookup in \('matched', 'none_nearby', 'could_not_look'\)\)/, "three values, closed");
  assert.match(columns, /alter column brick_lookup set default 'could_not_look'/, "the default is the UNKNOWN value, never matched");

  const writes = readFileSync("supabase/migrations/20261008024500_phoenix_crm_place_brick_lookup_write.sql", "utf8");
  assert.ok((writes.match(/'could_not_look'\)/g) ?? []).length >= 2, "both the insert and the move fall back to the unknown value");
  console.log("phoenix-crm place brick lookup: OK");
}
