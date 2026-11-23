/**
 * Place checks — the decided read: the places in use, with their timetable and signboard.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { PLACE_CUSTOMER_STATUS_JOIN, SIGNBOARD_CHECK_KEYS_SELECT, signboardCheckRead } from "@/lib/phoenix-crm/place-checks-slim-read";
import { parseScheduleLegibility, parseScheduleProblem } from "@/lib/phoenix-crm/schedule-rules";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { customerKindText } from "@/lib/phoenix-crm/speciality-list";
import { placeChecksSeatScope, readsCompanyPlaceChecks, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { approvalLockFor } from "@/lib/phoenix-crm/server/super-admin-approval";
import { numberOrNull, seatScoped, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadSharedPlaceNames } from "@/lib/phoenix-crm/server/shared-places";
import { parseSignboardPhotoProblem, signboardRetakeWaiting } from "@/lib/phoenix-crm/signboard-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { deciderLabel, newestValidatedFirst, reading, type Row, text } from "@/lib/phoenix-crm/server/validation-reviews/shared";
import type { ValidatedPlaceRow, ValidationBoardRead } from "@/lib/phoenix-crm/server/validation-reviews/types";

/**
 * Every place still active and not already waiting in the queue above — newest first, so "he just
 * validated this, take it back" is the top row.
 *
 * 🔴 NO DATE FLOOR AND NO 400-ROW CAP ANY MORE (2026-10-08). It read the newest 400 of the last 30 days,
 * so on the day it was measured the page showed 400 of 612 and presented that as the field — and the
 * 30-day floor made the board's own "Any time" period a lie. The whole set goes to the browser on
 * purpose: the board filters rep, line, region, area, list, period and text IN THE BROWSER, so a server
 * page would make every filter answer about one page. It pages with a total order and stops at a
 * ceiling far above the field, and says so when it does.
 *
 * 🔴 THE PAGES WALK THE PRIMARY KEY; THE NEWEST-FIRST ORDER IS MADE HERE, NOT IN THE DATABASE (production
 * read audit, 28 Oct 2026). There is no index on `created_at`, so `ORDER BY created_at DESC, id DESC`
 * made every one of the ~5 pages a load reads scan and sort the whole table (4,178 rows at about 1.8 KB
 * each) to return 1,000 of them — 1,440 calls, 116 s over 25–28 Oct. `id` alone is still a total order,
 * which is all the pager needs, and the primary key serves it with no sort. The rows are then put back
 * in `created_at desc, id desc` by `newestValidatedFirst`, so the board shows exactly the order it did.
 * At the ceiling the read keeps the first 10,000 by id rather than the newest — with the whole table
 * under half of that, today's answer is the same, and `capped` still says when it happens.
 *
 * 🔴 `seatedOnly` IS THE SUPER ADMIN'S PAGE OPENING (owner, 23 Nov 2026: "Fix speed next"). The page draws
 * only the places seated in a building — a building's card shows everybody in it — and used to read every
 * place in use to send those: 7,124 places and 13 MB read for the 513 it sent, most of the 12 seconds
 * before the first waiting place was on screen. With `seatedOnly` the database answers the seated ones
 * alone, one page; every place in use is the read behind the click (`server/place-checks-wide-read.ts`).
 */
export type ValidatedPlacesRead = { seatedOnly?: boolean };

export async function loadValidatedPlaces(viewer: PhoenixCrmViewer, options?: ValidatedPlacesRead): Promise<ValidationBoardRead<ValidatedPlaceRow>> {
  const seats = placeChecksSeatScope(viewer);
  const seatedOnly = options?.seatedOnly === true;
  const decides = readsCompanyPlaceChecks(viewer);
  const read = await readEveryPage<Row>(
    () => {
      const query = getSupabaseAdmin()
        .from("phoenix_crm_places")
        .select(
          // 🔴 ONE STRING, AND A COLUMN THAT IS NOT THERE YET FAILS THE WHOLE READ. `shared_place_id`
          // and `schedule_check` arrive with migration 20261010013001, which reaches staging and
          // production before this file ships.
          // The signboard by the keys the board reads, never whole (`SIGNBOARD_CHECK_KEYS_SELECT`): the
          // whole column was 7.7 of this read's 16 MB. The timetable check is kept whole — 0.4 MB, and
          // picking its seven keys out would cost more in empty keys than it saves.
          `id, seat_id, customer_id, is_test, label, address, brick_name, area_name, lat, lon, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, created_by_hr_id, created_at, ${SIGNBOARD_CHECK_KEYS_SELECT}, shared_place_id, schedule_check, point_source, ${PLACE_CUSTOMER_STATUS_JOIN}`,
        )
        .eq("status", "active")
        // A copy validated from another line has no evidence of its own to check; its source is on the board.
        .neq("point_source", "line_twin")
        // 🔴 A DROPPED CUSTOMER'S PLACE IS NOT "Validated, in use" (owner, 17 Nov 2026, the audit's wrong
        // counts): 77 places of dropped customers were counted there, 63 of them under "Never looked at".
        // His place stays active for the day he is brought back; it is simply nobody's work here.
        .neq("customer.status", "dropped");
      const scoped = seatScoped(query, seats);
      return (seatedOnly ? scoped.not("shared_place_id", "is", null) : scoped).order("id", { ascending: false });
    },
    // Four pages at once (2026-11-08): ~5,400 active places are six pages, and one after another they
    // were four seconds of the page on their own. Eight since 16 Nov 2026: 6,558 places are seven pages,
    // and four at a time made three waves one after another (0.7 + 0.9 + 0.3 s) where one wave and the
    // closing empty page now do. A district manager's team is about one page (438 places for the one
    // measured, 16 Nov 2026), so his read goes one page at a time: eight at once sent seven empty ones.
    {
      maxRows: 10_000,
      whenFull: "stop",
      what: "The validated places in use",
      uniqueBy: (row) => String(row.id),
      // The seated places are one page too (513 on 23 Nov 2026), so that read never sends seven empty ones.
      concurrentPages: seats || seatedOnly ? 1 : 8,
    },
  );
  throwIfError(read.error);
  const places = [...read.rows].sort(newestValidatedFirst);
  if (places.length === 0) return { rows: [], capped: false };

  // 🔴 ONE CALL, NOT 179 (owner, 2026-11-08: "enhance more the performance of this page, hilarious slow").
  // The four lookups below went 150 ids at a time — 61 requests for the visit count alone, 179 in all, the
  // biggest share of the page. `phoenix_crm_validated_place_facts` takes the ids in the request BODY (an
  // RPC is a POST, so none of the ~395-id `.in()` header overflow that once took this page down, 2026-10-07) and answers in one jsonb value, which
  // PostgREST's row cap never cuts. Every review of these customers, whatever its status: the pending ones
  // are held above and left out here, and ANY one at all means somebody has looked at that place.
  //
  // 🔴 AND THAT CALL IS ASKED IN UP TO FOUR PARTS AT ONCE (owner, 16 Nov 2026: "fix the place checks
  // slowness"): for every place in one go it took 1.1 s after the last page, alone on the clock. Every fact
  // it returns is keyed by the place or the customer it was asked about — a customer's places and reviews
  // are counted over the whole table, never over the ids sent with it — so the parts merge back to exactly
  // the one call's answer: a customer whose places fall in two parts comes back twice, the same both times.
  type PlaceFacts = { customers?: Row[]; reviews?: Row[]; visit_counts?: Record<string, number>; active_places?: Record<string, number> };
  const factParts = Math.min(4, Math.max(1, Math.ceil(places.length / 1_000)));
  const partSize = Math.ceil(places.length / factParts);
  const factAnswers = await Promise.all(
    Array.from({ length: factParts }, async (_, index) => {
      const part = places.slice(index * partSize, (index + 1) * partSize);
      const facts = await getSupabaseAdmin().rpc("phoenix_crm_validated_place_facts", {
        p_place_ids: part.map((row) => String(row.id)),
        p_customer_ids: [...new Set(part.map((row) => String(row.customer_id)))],
      });
      throwIfError(facts.error);
      return (facts.data ?? {}) as PlaceFacts;
    }),
  );
  const customerFacts = new Map<string, Row>();
  const reviewFacts = new Map<string, Row>();
  const factValue: Required<Pick<PlaceFacts, "visit_counts" | "active_places">> = { visit_counts: {}, active_places: {} };
  for (const answer of factAnswers) {
    for (const row of answer.customers ?? []) customerFacts.set(String(row.id), row);
    for (const row of answer.reviews ?? []) reviewFacts.set(String(row.id), row);
    Object.assign(factValue.visit_counts, answer.visit_counts ?? {});
    Object.assign(factValue.active_places, answer.active_places ?? {});
  }
  const customers = [...customerFacts.values()];
  const reviewRows = [...reviewFacts.values()];
  const customerById = new Map(customers.map((row) => [String(row.id), row]));
  const held = new Set(reviewRows.filter((row) => row.status === "pending").map((row) => String(row.place_id)));
  const reviewed = new Set(reviewRows.map((row) => String(row.place_id)));
  // One review row per place, for all time (the UNIQUE index), so the approval that let a place stand is
  // this row and no other; a pending or rejected one says nothing about who approved it.
  const approvals = new Map(reviewRows.filter((row) => row.status === "approved").map((row) => [String(row.place_id), row] as const));
  const visitsByPlace = new Map<string, number>(Object.entries(factValue.visit_counts).map(([placeId, count]) => [placeId, Number(count)]));
  const placesByCustomer = new Map<string, number>(Object.entries(factValue.active_places).map(([customerId, count]) => [customerId, Number(count)]));
  const [names, venues, lockedFor] = await Promise.all([
    loadPeopleNames([
      ...places.map((row) => text(row.created_by_hr_id)),
      ...[...approvals.values()].map((row) => text(row.decided_by_hr_id)),
    ]),
    // The venue each seated place sits in, by name — the Super Admin reads names, never ids.
    loadSharedPlaceNames(places.map((row) => text(row.shared_place_id))),
    approvalLockFor(viewer),
  ]);

  const rows = places
    .filter((row) => !held.has(String(row.id)))
    .map((row): ValidatedPlaceRow => {
      const customer = customerById.get(String(row.customer_id)) ?? {};
      const point = { lat: numberOrNull(row.lat) ?? 0, lon: numberOrNull(row.lon) ?? 0 };
      const seat = viewer.org.seats.get(String(row.seat_id));
      return {
        placeId: String(row.id),
        customerId: String(row.customer_id),
        customerName: String(customer.name ?? "Unknown customer"),
        listType: String(customer.list_type ?? ""),
        speciality: customerKindText(text(customer.customer_type), text(customer.speciality)),
        isTest: row.is_test === true,
        repName: nameOf(names, text(row.created_by_hr_id), "A rep"),
        territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
        line: seat?.lineName ?? null,
        region: seat?.regionName ?? null,
        validatedAt: String(row.created_at),
        validatedAtText: formatPhoenixDateTime(String(row.created_at)),
        placeLabel: text(row.label),
        address: text(row.address),
        brickName: text(row.brick_name),
        areaName: text(row.area_name),
        point,
        mapsLink: `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lon}`,
        pin: reading(row.pin_lat, row.pin_lon, row.pin_accuracy_meters),
        photo: reading(row.photo_lat, row.photo_lon, row.photo_accuracy_meters),
        photoPath: text(row.photo_path),
        trustedPoint: row.point_source === "trusted",
        lockedBySuperAdmin: lockedFor(approvals.get(String(row.id))?.decided_by_hr_id, row.created_by_hr_id),
        waitsForBuilding: approvals.has(String(row.id)) && (row.customer as Row | null)?.status === "pending" && text(row.shared_place_id) !== null,
        visits: visitsByPlace.get(String(row.id)) ?? 0,
        otherPlaces: Math.max((placesByCustomer.get(String(row.customer_id)) ?? 1) - 1, 0),
        reviewed: reviewed.has(String(row.id)),
        decidedByName: decides ? deciderLabel(names, text(approvals.get(String(row.id))?.decided_by_hr_id)) : null,
        decidedAtText: text(approvals.get(String(row.id))?.decided_at)
          ? formatPhoenixDateTime(String(approvals.get(String(row.id))?.decided_at))
          : null,
        signboard: signboardOf(signboardCheckRead(row)),
        photoKind: text(row.shared_place_id) ? "schedule" : "signboard",
        sharedPlaceName: venues.get(String(row.shared_place_id ?? ""))?.name ?? null,
        sharedPlaceId: text(row.shared_place_id),
        schedule: scheduleOf(row.schedule_check),
      };
    });
  return { rows, capped: read.capped };
}

/** The stored timetable verdict, read as defensively as the signboard's: unrecognised is "not read". */
export function scheduleOf(value: unknown): ValidatedPlaceRow["schedule"] {
  if (!value || typeof value !== "object") return null;
  const check = value as Row;
  const verdict = check.verdict;
  if (verdict !== "match" && verdict !== "other_name" && verdict !== "no_schedule" && verdict !== "unjudged") return null;
  return {
    verdict,
    scheduleText: text(check.scheduleText),
    hoursRead: text(check.hoursRead),
    reason: text(check.reason),
    legibility: parseScheduleLegibility(check.legibility),
    problem: parseScheduleProblem(check.problem),
    uploaded: check.uploaded === true,
  };
}

/** The stored signboard verdict, read defensively: anything unrecognised is "not read yet". */
export function signboardOf(value: unknown): ValidatedPlaceRow["signboard"] {
  if (!value || typeof value !== "object") return null;
  const check = value as Row;
  const verdict = check.verdict;
  if (verdict !== "match" && verdict !== "other_name" && verdict !== "no_name" && verdict !== "unjudged") return null;
  return {
    problem: parseSignboardPhotoProblem(check.problem),
    reason: text(check.reason),
    retake: signboardRetakeWaiting(check) !== null,
    signText: text(check.signText),
    verdict,
  };
}
