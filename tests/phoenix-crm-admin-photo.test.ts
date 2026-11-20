import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { PLACE_MAX_ACCURACY_METERS } from "../src/lib/phoenix-crm/entry-rules.ts";
import {
  ADMIN_PHOTO_WATCH_MINUTES,
  adminPhotoReadingProblem,
  adminPhotoTimeText,
  adminPhotoWatchIsOpen,
  adminPhotoWatchUntil,
} from "../src/lib/phoenix-crm/admin-photo-rules.ts";

/**
 * Phoenix CRM — the Super Admin validates a customer with a PHOTO HE UPLOADS while the rep captures the location
 * (owner, 2026-11-20: "must have a photo except i tell u", then "the system administrator can validate for someone
 * and upload a photo manually instead of the live", then "make a button for me to press on watch the rep while
 * capturing location ... while this button is on, the rep will capture the location").
 *
 * 1. The rules, behaviourally: the rep's reading stands only with a known accuracy within the validated place's
 *    line (250 m), never at 0,0; a watch is open only while watching or captured and inside its time.
 * 2. By source: the Super Admin's route asks `update` and his service asks `canDecideSharedPlaces`; the rep's
 *    route asks `create` and his service asks `territoryForValidation`; the rep's payload carries four keys and
 *    nothing that names a watch, a person or a distance (golden rule #1); the database function is a known writer.
 * 3. The migration: the table and the function are closed to the browser roles, and the function refuses a
 *    validation with no reading.
 *
 * Break direction: let an unknown accuracy through and section 1 fails; hand the rep the watch's end time and
 * section 2 fails; drop the function's revoke and section 3 fails.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function rulesBehave(): void {
  const good = { lat: 30.0131, lon: 31.2089 };
  assert.equal(adminPhotoReadingProblem({ ...good, accuracyMeters: 12 }), null, "a sharp reading stands");
  assert.equal(
    adminPhotoReadingProblem({ ...good, accuracyMeters: PLACE_MAX_ACCURACY_METERS }),
    null,
    "a reading exactly on the place line stands",
  );
  assert.equal(PLACE_MAX_ACCURACY_METERS, 250, "the validated place's line is 250 m");
  assert.ok(adminPhotoReadingProblem({ ...good, accuracyMeters: PLACE_MAX_ACCURACY_METERS + 1 }), "past the line is refused");
  assert.ok(adminPhotoReadingProblem({ ...good, accuracyMeters: null }), "an unknown accuracy is refused");
  assert.ok(adminPhotoReadingProblem({ ...good, accuracyMeters: 0 }), "a zero accuracy is refused");
  assert.ok(adminPhotoReadingProblem({ lat: 0, lon: 0, accuracyMeters: 10 }), "0,0 is no reading");
  assert.ok(adminPhotoReadingProblem({ lat: null, lon: 31, accuracyMeters: 10 }), "a missing latitude is refused");
  assert.ok(adminPhotoReadingProblem({ lat: "x", lon: 31, accuracyMeters: 10 }), "a word is no latitude");
  assert.ok(adminPhotoReadingProblem({ lat: 91, lon: 31, accuracyMeters: 10 }), "off the globe is refused");

  const refusal = adminPhotoReadingProblem({ ...good, accuracyMeters: 900 }) ?? "";
  for (const banned of [/\bcheck/i, /\bwatch/i, /\badmin/i, /\bsuper\b/i, /\bfar\b/i]) {
    assert.doesNotMatch(refusal, banned, `the rep's refusal must not name ${banned}`);
  }

  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const until = adminPhotoWatchUntil(now);
  assert.equal(Date.parse(until) - now, ADMIN_PHOTO_WATCH_MINUTES * 60_000, "a watch lasts its minutes");
  assert.equal(adminPhotoWatchIsOpen({ status: "watching", watchUntil: until }, now), true);
  assert.equal(adminPhotoWatchIsOpen({ status: "captured", watchUntil: until }, now), true, "a new reading may replace the last");
  assert.equal(adminPhotoWatchIsOpen({ status: "watching", watchUntil: until }, Date.parse(until)), false, "the end is closed");
  assert.equal(adminPhotoWatchIsOpen({ status: "validated", watchUntil: until }, now), false);
  assert.equal(adminPhotoWatchIsOpen({ status: "cancelled", watchUntil: until }, now), false);
  assert.equal(adminPhotoWatchIsOpen({ status: "watching", watchUntil: null }, now), false, "no end is no watch");

  assert.equal(adminPhotoTimeText("2026-11-20T12:05:00.000Z"), "20 Nov, 14:05", "Cairo time");
  assert.equal(adminPhotoTimeText(null), "");
}

function sourceHoldsTheDoors(): void {
  const adminRoute = read("app/api/phoenix-crm/list/places/admin-photo/route.ts");
  const askRoute = read("app/api/phoenix-crm/list/places/admin-photo/ask/route.ts");
  assert.equal(adminRoute.split('assertPermission(access, "phoenix_crm", "update")').length - 1, 2, "both Super Admin verbs ask update");
  assert.match(adminRoute, /assertSameOriginMutation\(request\)/);
  assert.equal(askRoute.split('assertPermission(access, "phoenix_crm", "create")').length - 1, 2, "both rep verbs ask create");
  assert.match(askRoute, /assertSameOriginMutation\(request\)/);

  const service = read("src/lib/phoenix-crm/server/admin-photo.ts");
  assert.match(
    service,
    /export function canValidateWithAdminPhoto\(viewer: PhoenixCrmViewer\): boolean \{\s*return canDecideSharedPlaces\(viewer\);/,
    "only the Super Admin validates with an uploaded photo",
  );
  for (const name of ["loadAdminPhotoState", "armAdminPhotoValidation", "rewatchAdminPhotoValidation", "cancelAdminPhotoValidation", "applyAdminPhotoValidation"]) {
    const start = service.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const body = service.slice(start, service.indexOf("\n}\n", start));
    assert.match(body, /assertAdminPhotoDecider\(viewer\)/, `${name} asks who before it reads anything`);
  }
  for (const name of ["loadAdminPhotoAsks", "sendAdminPhotoReading"]) {
    const start = service.indexOf(`export async function ${name}(`);
    const body = service.slice(start, service.indexOf("\n}\n", start));
    assert.match(body, /territoryForValidation\(viewer,/, `${name} asks the rep's own validation gate`);
  }
  assert.match(service, /adminPhotoReadingProblem\(/, "the server refuses a rough reading, not only the phone");

  const askType = /export type AdminPhotoRepAsk = \{([^}]*)\};/.exec(service);
  assert.ok(askType, "the rep's payload type exists");
  const keys = askType[1].split(";").map((part) => part.trim().split(":")[0].trim()).filter(Boolean).sort();
  assert.deepEqual(keys, ["askId", "customerId", "customerName", "sent"], "the rep receives four keys and nothing else");
  const mapStart = service.indexOf("askId: String(row.id)");
  const mapped = service.slice(service.lastIndexOf("({", mapStart), service.indexOf("})", mapStart));
  for (const banned of ["watch_until", "watchUntil", "accuracy", "by_hr_id", "photo"]) {
    assert.ok(!mapped.includes(banned), `the rep's payload never carries ${banned}`);
  }

  const card = read("src/components/phoenix-crm/admin-photo-ask-card.tsx");
  for (const banned of [/\bwatch/i, /\bsuper admin/i, /\baccura/i, /\bminutes?\b/i]) {
    const strings = card.match(/"[^"\n]*"|>[^<>{}\n]+</g) ?? [];
    assert.ok(!strings.some((text) => banned.test(text)), `the rep's card never says ${banned}`);
  }
  assert.doesNotMatch(card, /setInterval|setTimeout/, "the rep's card never asks on a timer");

  assert.match(read("src/lib/phoenix-crm/server/db.ts"), /"phoenix_crm_validate_with_admin_photo",/);
  assert.match(read("src/lib/phoenix-crm/server/readiness-reuse.ts"), /"phoenix_crm_validate_with_admin_photo",/);
}

function migrationClosesTheDoor(): void {
  const sql = read("supabase/migrations/20261120125729_phoenix_crm_admin_photo_validations.sql");
  assert.match(sql, /revoke all on table public\.phoenix_crm_admin_photo_validations from public, anon, authenticated;/);
  assert.match(sql, /alter table public\.phoenix_crm_admin_photo_validations enable row level security;/);
  assert.match(
    sql,
    /revoke execute on function public\.phoenix_crm_validate_with_admin_photo\(jsonb\) from public, anon, authenticated;/,
  );
  assert.match(sql, /grant execute on function public\.phoenix_crm_validate_with_admin_photo\(jsonb\) to service_role;/);
  assert.match(sql, /photo_path text not null/, "a watch never exists without the uploaded photo");
  assert.match(
    sql,
    /if v_watch\.status = 'watching' then\s*raise exception 'phoenix_crm:admin_photo_no_reading';/,
    "nothing is validated before the rep's reading arrives",
  );
  assert.match(sql, /admin_photo_by_hr_id is not null\)/, "the timings rule admits only this door beside the trusted point");
}

export async function runPhoenixCrmAdminPhotoTests(): Promise<void> {
  rulesBehave();
  sourceHoldsTheDoors();
  migrationClosesTheDoor();
}
