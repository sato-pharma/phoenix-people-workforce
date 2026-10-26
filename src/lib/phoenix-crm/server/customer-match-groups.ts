/**
 * Phoenix CRM — the same customer validated by more than one rep: the read (owner, 2026-10-26, the fourth
 * tab of Place checks).
 *
 * The rule is `customer-match-groups.ts`; this file is only what feeds it. It stores nothing: the tab lists
 * what the validations themselves say, and a validation that changes changes the list.
 *
 * 🔴 THE DECIDERS' ALONE — the same reader as "Same place, several reps" (`canReadPlaceMatches`): it sets
 * one rep's validations beside another's, across teams.
 *
 * 🔴 EVERY READ IS PAGED — a bare read answers its first 1,000 rows and says nothing.
 */

import { forbiddenError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import { buildCustomerMatchBoard, type CustomerMatchBoard, type CustomerSubject } from "@/lib/phoenix-crm/customer-match-groups";
import { personNameWords } from "@/lib/phoenix-crm/signboard-rules";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { placeChecksSeatScope, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { seatScoped, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { canReadPlaceMatches, matchAnchorOf } from "@/lib/phoenix-crm/server/place-match-groups";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

function fixOf(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  return isUsableFix(lat, lon) ? { lat: Number(lat), lon: Number(lon) } : null;
}

const PLACE_COLUMNS =
  "id, seat_id, customer_id, address, brick_name, area_name, lat, lon, accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, " +
  "photo_lat, photo_lon, photo_accuracy_meters, photo_path, created_by_hr_id, created_at";

export type CustomerMatchRead = { board: CustomerMatchBoard; capped: boolean };

export async function loadCustomerMatchBoard(viewer: PhoenixCrmViewer): Promise<CustomerMatchRead> {
  if (!canReadPlaceMatches(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager read this.");

  const placeRead = await readEveryPage<Row>(
    () =>
      seatScoped(getSupabaseAdmin().from("phoenix_crm_places").select(PLACE_COLUMNS).eq("status", "active").eq("is_test", false), placeChecksSeatScope(viewer))
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    { maxRows: 10_000, whenFull: "stop", what: "The validated places in use", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(placeRead.error);
  const places = placeRead.rows;

  const customerIds = [...new Set(places.map((row) => String(row.customer_id)))];
  const [customers, names] = await Promise.all([
    selectByIds<Row>("phoenix_crm_customers", "id, name, list_type, speciality", "id", customerIds),
    loadPeopleNames(places.map((row) => text(row.created_by_hr_id))),
  ]);
  const customerById = new Map(customers.map((row) => [String(row.id), row]));

  const subjects: CustomerSubject[] = [];
  for (const row of places) {
    const anchor = matchAnchorOf(row);
    if (!anchor) continue;
    const customer = customerById.get(String(row.customer_id)) ?? {};
    const customerName = String(customer.name ?? "");
    const nameWords = personNameWords(customerName).map((word) => word.word);
    if (nameWords.length < 2) continue;
    const seat = viewer.org.seats.get(String(row.seat_id));
    subjects.push({
      key: `place:${String(row.id)}`,
      id: String(row.id),
      seatId: String(row.seat_id),
      repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
      territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
      line: seat?.lineName ?? null,
      region: seat?.regionName ?? null,
      title: customerName,
      listType: String(customer.list_type ?? ""),
      speciality: text(customer.speciality),
      nameWords,
      point: anchor.point,
      pin: fixOf(row.pin_lat, row.pin_lon),
      photo: fixOf(row.photo_lat, row.photo_lon),
      pinGapMeters: anchor.pinGapMeters === null ? null : Math.round(anchor.pinGapMeters),
      areaName: text(row.area_name),
      brickName: text(row.brick_name),
      address: text(row.address),
      capturedAt: String(row.created_at),
      capturedAtText: formatPhoenixDateTime(String(row.created_at)),
      photoPath: text(row.photo_path),
    });
  }

  return { board: buildCustomerMatchBoard({ subjects }), capped: placeRead.capped };
}
