/**
 * ONE-OFF OPS SCRIPT — plan the two data repairs of the Phoenix CRM validation audit (11 November 2026).
 *
 * Owner, 2026-11-11: "All three" data repairs and the three hospital accounts "Back to To validate". The
 * third repair (places with no brick) has its own planner, scripts/phoenix-crm-refile-no-brick-places.ts.
 * This one plans the other two, and asks the SAME functions the app asks:
 *
 *   A · every real doctor or account that is on the list (`status = 'active'`), holds the validated stamp
 *       and holds NO active place goes back to "To validate" — the statement and the `customer_pending`
 *       event a rejected validation writes (20261015212903), with `why = 'validated_without_place'`. A
 *       customer in the Archive keeps his stamp: the bring-back doors test the place when he returns
 *       (20261111013233). No visit is touched; the countable views read `validated_at` themselves.
 *
 *   B · every visit `visitHeldBeforePlace` would have held, had the rule existed when the customer got his
 *       place: the rep's own entry, on or after the far rule's first day, never copied and never archived,
 *       saved while the customer had no place row of any status, and past the refusal's own line
 *       (`farRefusalLineFor`) of the place `placesFor` measures it against, by the nearer of that place's
 *       two readings (`visitAwayFromValidatedPlace`). It gets the hold `holdVisitsBeforePlace` writes:
 *       basis `before_place`, tries 0, waiting for the SFE. No visit row is changed, so every visit still
 *       proves its worked day (src/lib/crm/phoenix-work-evidence.ts reads the base table).
 *
 * IT ONLY WRITES FILES, into F:\PHX backup\phoenix-crm-validation-repair-<date>\ :
 *   plan.json      — every customer and visit, by name;
 *   pre-image.sql  — the customers' whole rows and the visits about to be held, into phoenix_crm_backup_<date>;
 *   apply.sql      — the guarded update with its events, and the holds, in one transaction.
 * Applying is a BULK PRODUCTION CHANGE (AGENTS.md §8): announce it, then
 *   node scripts/apply-sql-file.mjs <folder>/pre-image.sql production
 *   node scripts/apply-sql-file.mjs <folder>/apply.sql production
 * each with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-crm-validation-repair-plan.ts [--out=<folder>]
 */
import fs from "node:fs";
import path from "node:path";

import { farVisitRefusalApplies, FAR_VISIT_REFUSAL_FROM_DAY, visitAwayFromValidatedPlace, type ValidatedPlaceReading } from "@/lib/phoenix-crm/entry-rules";
import { farRefusalLineFor, visitHeldBeforePlace } from "@/lib/phoenix-crm/far-visit-safeguards";
import { personKey } from "@/lib/phoenix-crm/scope";
import { loadPhoenixCrmConfig } from "@/lib/phoenix-crm/server/settings";
import { placesFor } from "@/lib/phoenix-crm/server/visit-locations";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const DATE = "20261111";
const BACKUP_SCHEMA = `phoenix_crm_backup_${DATE}`;
/** The owner decided it: he is the sole Super Admin, and every decision is his. */
const ACTOR = "B-10";

const known = new Set(["out"]);
for (const entry of process.argv.slice(2)) {
  const name = entry.replace(/^--/, "").split("=")[0];
  if (!known.has(name)) throw new Error(`Unknown flag ${entry} — refused rather than ignored.`);
}
const outArg = process.argv.find((entry) => entry.startsWith("--out="));
const outDir = outArg ? outArg.slice("--out=".length) : path.join("F:\\PHX backup", `phoenix-crm-validation-repair-${DATE}`);

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
const uuid = (value: unknown): string => {
  const id = text(value);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Not a uuid: ${id}`);
  return id;
};
const sqlText = (value: string | null): string => (value === null ? "null" : `'${value.replace(/'/g, "''")}'`);
const sqlNumber = (value: number | null): string => (value === null ? "null" : String(value));

async function main(): Promise<void> {
  const supabase = getSupabaseAdmin();
  const config = await loadPhoenixCrmConfig();
  const visitFarMeters = Number(config.settings.visitFarMeters);
  if (!Number.isFinite(visitFarMeters) || visitFarMeters <= 0) throw new Error("The far line could not be read from the settings.");

  const [customers, places, visits, holds, people] = await Promise.all([
    fetchAllRows<Row>(
      () =>
        supabase
          .from("phoenix_crm_customers")
          .select("id, seat_id, name, list_type, origin, status, validated_at, validated_by_hr_id, reference_contact_crm_id")
          .eq("is_test", false)
          .in("list_type", ["AM", "PM"]),
      "id",
    ),
    fetchAllRows<Row>(
      () =>
        supabase
          .from("phoenix_crm_places")
          .select("id, seat_id, customer_id, status, created_at, captured_at, lat, lon, photo_lat, photo_lon, photo_accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, point_source")
          .eq("is_test", false),
      "id",
    ),
    fetchAllRows<Row>(
      () =>
        supabase
          .from("phoenix_crm_visits")
          .select("id, seat_id, customer_id, list_type, kind, visit_date, captured_at, created_at, lat, lon, rep_hr_id, entered_by_hr_id, manager_hr_id, distance_meters, location_flag")
          .eq("is_test", false)
          .is("archived_at", null)
          .is("imported_from_ireports360_at", null)
          .gte("visit_date", FAR_VISIT_REFUSAL_FROM_DAY)
          .in("list_type", ["AM", "PM"]),
      "id",
    ),
    fetchAllRows<Row>(() => supabase.from("phoenix_crm_far_visit_holds").select("visit_id"), "visit_id"),
    fetchAllRows<Row>(() => supabase.from("employees").select("hr_id, full_name"), "hr_id"),
  ]);

  const nameOf = new Map(people.map((row) => [personKey(text(row.hr_id)), text(row.full_name)]));
  const customerOf = new Map(customers.map((row) => [text(row.id), row]));
  const placesOf = new Map<string, Row[]>();
  for (const place of places) {
    const key = text(place.customer_id);
    placesOf.set(key, [...(placesOf.get(key) ?? []), place]);
  }
  const activePlacesOf = (customerId: string): Row[] => (placesOf.get(customerId) ?? []).filter((place) => place.status === "active");
  const heldAlready = new Set(holds.map((row) => text(row.visit_id)));

  // ── A · on the list, validated, and no active place ───────────────────────────────────────────
  const toReopen = customers
    .filter((customer) => customer.status === "active" && customer.validated_at != null && activePlacesOf(text(customer.id)).length === 0)
    .map((customer) => {
      const id = uuid(customer.id);
      const theirs = visits.filter((visit) => text(visit.customer_id) === id);
      return {
        id,
        seatId: text(customer.seat_id),
        name: text(customer.name),
        listType: text(customer.list_type),
        origin: text(customer.origin),
        validatedAt: text(customer.validated_at),
        validatedBy: nameOf.get(personKey(text(customer.validated_by_hr_id))) ?? text(customer.validated_by_hr_id),
        placesEver: (placesOf.get(id) ?? []).length,
        visitsSinceFarRule: theirs.length,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  // ── B · logged before the customer had a place, and past the line of it ───────────────────────
  const toHold: Array<Row> = [];
  for (const visit of visits) {
    const id = uuid(visit.id);
    const customerId = text(visit.customer_id);
    const customer = customerOf.get(customerId);
    const lat = numberOrNull(visit.lat);
    const lon = numberOrNull(visit.lon);
    const repHrId = text(visit.rep_hr_id);
    const visitDate = text(visit.visit_date).slice(0, 10);
    if (!customer || heldAlready.has(id) || lat === null || lon === null || !repHrId || !visitDate) continue;
    const all = (placesOf.get(customerId) ?? []).filter((place) => text(place.seat_id) === text(visit.seat_id));
    const active = all.filter((place) => place.status === "active");
    if (active.length === 0) continue;
    // Saved while the customer had no place row of ANY status: the save had nothing to measure against,
    // so the far rule never judged it. A visit the save measured against a place since retired is not this.
    const savedAt = text(visit.created_at);
    if (all.some((place) => text(place.created_at) <= savedAt)) continue;

    const measurable = active.map((place) => ({
      id: text(place.id),
      lat: Number(place.lat),
      lon: Number(place.lon),
      capturedAt: text(place.captured_at),
      reading: {
        id: text(place.id),
        lat: Number(place.lat),
        lon: Number(place.lon),
        photoLat: numberOrNull(place.photo_lat),
        photoLon: numberOrNull(place.photo_lon),
        photoAccuracyMeters: numberOrNull(place.photo_accuracy_meters),
        pinLat: numberOrNull(place.pin_lat),
        pinLon: numberOrNull(place.pin_lon),
        pinAccuracyMeters: numberOrNull(place.pin_accuracy_meters),
        pointSource: typeof place.point_source === "string" ? place.point_source : null,
      } satisfies ValidatedPlaceReading,
    }));
    const measured = new Set(placesFor({ capturedAt: text(visit.captured_at) || null, copiedFromOldSystem: false }, measurable).map((place) => place.id));
    const away = visitAwayFromValidatedPlace({
      fix: { lat, lon },
      places: measurable.filter((place) => measured.has(place.id)).map((place) => place.reading),
      farMeters: farRefusalLineFor(customer.list_type, visitFarMeters),
    });
    const hold = visitHeldBeforePlace({
      farRuleApplies: farVisitRefusalApplies(visitDate),
      enteredByRep: personKey(text(visit.entered_by_hr_id)) === personKey(repHrId),
      copiedFromOldSystem: false,
      archived: false,
      pastTheLine: away.refused,
    });
    if (!hold) continue;
    toHold.push({
      visitId: id,
      seatId: text(visit.seat_id),
      repHrId: repHrId.toUpperCase(),
      rep: nameOf.get(personKey(repHrId)) ?? repHrId,
      customerId: uuid(customerId),
      customer: text(customer.name),
      listType: text(customer.list_type),
      customerValidated: customer.validated_at != null,
      kind: text(visit.kind),
      withManager: visit.manager_hr_id != null,
      placeId: away.placeId === null ? null : uuid(away.placeId),
      metres: away.metres === null ? null : Math.round(away.metres),
      farMeters: Math.round(away.farMeters),
      storedFlag: text(visit.location_flag),
      storedMetres: numberOrNull(visit.distance_meters),
      lat,
      lon,
      visitDate,
    });
  }
  toHold.sort((left, right) => text(left.rep).localeCompare(text(right.rep)) || text(left.visitDate).localeCompare(text(right.visitDate)));

  const reopenIds = toReopen.map((customer) => `  '${customer.id}'`).join(",\n");
  const holdIds = toHold.map((visit) => `  '${text(visit.visitId)}'`).join(",\n");

  const preImage = [
    `-- Pre-image for scripts/phoenix-crm-validation-repair-plan.ts (${DATE}): the whole rows, before anything is written.`,
    "begin;",
    `create schema if not exists ${BACKUP_SCHEMA};`,
    `revoke all on schema ${BACKUP_SCHEMA} from public, anon, authenticated;`,
    toReopen.length > 0
      ? `create table ${BACKUP_SCHEMA}.customers_validated_without_place as select * from public.phoenix_crm_customers where id in (\n${reopenIds}\n);`
      : "-- no customer to return to To validate",
    toHold.length > 0
      ? `create table ${BACKUP_SCHEMA}.visits_held_before_place as select * from public.phoenix_crm_visits where id in (\n${holdIds}\n);`
      : "-- no visit to hold",
    "commit;",
    "",
  ].join("\n");

  const apply = [
    `-- scripts/phoenix-crm-validation-repair-plan.ts (${DATE}): ${toReopen.length} customers back to "To validate", ${toHold.length} visits held for the SFE.`,
    "-- A customer who gained a place, left the list or lost the stamp since the plan was written is skipped; a visit already held keeps its hold.",
    "begin;",
    toReopen.length > 0
      ? [
          "with reopened as (",
          "  update public.phoenix_crm_customers c",
          "  set status = 'pending', validated_at = null, validated_by_hr_id = null, reopened_at = now(), status_changed_at = now(), updated_at = now()",
          `  where c.id in (\n${reopenIds}\n  )`,
          "    and c.is_test = false and c.status = 'active' and c.validated_at is not null and c.list_type in ('AM', 'PM')",
          "    and not exists (select 1 from public.phoenix_crm_places pl where pl.customer_id = c.id and pl.status = 'active')",
          "  returning c.id, c.seat_id, c.reference_contact_crm_id",
          ")",
          "insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)",
          `select r.seat_id, r.id, 'customer_pending', ${sqlText(ACTOR)},`,
          `  jsonb_build_object('reference_contact_crm_id', r.reference_contact_crm_id, 'why', 'validated_without_place', 'repair', ${sqlText(DATE)}), false`,
          "from reopened r;",
        ].join("\n")
      : "-- no customer to return to To validate",
    toHold.length > 0
      ? [
          "insert into public.phoenix_crm_far_visit_holds",
          "  (visit_id, seat_id, rep_hr_id, customer_id, place_id, distance_meters, far_meters, tries, basis, spot_lat, spot_lon, visit_date, is_test)",
          "select h.visit_id, h.seat_id, h.rep_hr_id, h.customer_id, h.place_id, h.distance_meters, h.far_meters, 0, 'before_place', h.spot_lat, h.spot_lon, h.visit_date, false",
          "from (values",
          toHold
            .map(
              (visit) =>
                `  ('${text(visit.visitId)}'::uuid, ${sqlText(text(visit.seatId))}, ${sqlText(text(visit.repHrId))}, '${text(visit.customerId)}'::uuid, ${visit.placeId === null ? "null::uuid" : `'${text(visit.placeId)}'::uuid`}, ${sqlNumber(visit.metres as number | null)}::integer, ${sqlNumber(visit.farMeters as number)}::integer, ${sqlNumber(visit.lat as number)}::double precision, ${sqlNumber(visit.lon as number)}::double precision, date '${text(visit.visitDate)}')`,
            )
            .join(",\n"),
          ") as h (visit_id, seat_id, rep_hr_id, customer_id, place_id, distance_meters, far_meters, spot_lat, spot_lon, visit_date)",
          "join public.phoenix_crm_visits v on v.id = h.visit_id and v.is_test = false and v.archived_at is null",
          "on conflict (visit_id) do nothing;",
        ].join("\n")
      : "-- no visit to hold",
    "commit;",
    "",
  ].join("\n");

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "plan.json"), `${JSON.stringify({ date: DATE, visitFarMeters, toReopen, toHold }, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "pre-image.sql"), preImage);
  fs.writeFileSync(path.join(outDir, "apply.sql"), apply);

  const byRep = new Map<string, number>();
  for (const visit of toHold) byRep.set(text(visit.rep), (byRep.get(text(visit.rep)) ?? 0) + 1);
  console.log(`read: ${customers.length} customers, ${places.length} places, ${visits.length} visits since ${FAR_VISIT_REFUSAL_FROM_DAY}, ${holds.length} holds; far line ${visitFarMeters} m`);
  console.log(`A · back to To validate: ${toReopen.length} (${toReopen.filter((c) => c.origin === "new").length} added by request, ${toReopen.filter((c) => c.origin !== "new").length} from the reference list); they hold ${toReopen.reduce((sum, c) => sum + c.visitsSinceFarRule, 0)} visits since ${FAR_VISIT_REFUSAL_FROM_DAY}`);
  console.log(`B · visits to hold: ${toHold.length} across ${byRep.size} reps; ${toHold.filter((v) => v.kind === "double").length} double; ${toHold.filter((v) => !v.customerValidated).length} to a customer not validated now`);
  for (const [rep, count] of [...byRep].sort((left, right) => right[1] - left[1])) console.log(`    ${count}  ${rep}`);
  console.log(`written: ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
