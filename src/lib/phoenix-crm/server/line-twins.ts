/**
 * Phoenix CRM — one doctor on the three lines' lists: the read and the write (owner, 2026-11-12: "if it is
 * one place in the three or one customer, then and it is validated, make in the three lines validation";
 * "You will compare only in the Phoenix validated customers"; "Both").
 *
 * The rule is `line-twins.ts`; this file feeds it and carries out what it plans:
 *
 *   - `shareAcrossLinesQuietly(customerId)` — after any validation, the doctor's rows on the other two lines
 *     of his area: validated twins whose points agree move onto one point, then waiting twins take the
 *     validation as copies. Best effort and silent: the validation it follows has already happened.
 *   - `runLineTwinPass` — the same over the whole country, for scripts/phoenix-crm-line-twins.ts (dry by
 *     default).
 *   - `followLineTwinCopiesQuietly(placeIds)` — the database moves a copy with its source
 *     (phoenix_crm_places_line_twin_follow); this re-measures the copies' visits after a move made here or
 *     on the Move place screen.
 *
 * 🔴 THE SYSTEM IS THE ACTOR (`SIGNBOARD_SYSTEM_ACTOR`, shown as "The system"), never a person: nobody
 * decided these rows by hand. A share's `validated_by_hr_id` is the source line's validator.
 *
 * 🔴 EVERY READ IS PAGED — a bare read answers its first 1,000 rows and says nothing.
 *
 * Account: docs/phoenix-crm-line-twins.md.
 */

import { withdrawInAppNotificationsByEventKeyPrefix } from "@/lib/notifications/in-app";
import { logError } from "@/lib/observability/log";
import {
  LINE_TWIN_MOVE_REASON,
  planLineTwinMerges,
  planLineTwinShares,
  twinNameWords,
  type LineTwinInput,
  type LineTwinMove,
  type LineTwinShare,
  type LineTwinSharePlan,
  type TwinCustomer,
  type TwinPlace,
} from "@/lib/phoenix-crm/line-twins";
import type { OrgIndex } from "@/lib/phoenix-crm/scope";
import { callPhoenixCrm, chunk, numberOrNull, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPhoenixCrmConfig } from "@/lib/phoenix-crm/server/settings";
import { SIGNBOARD_SYSTEM_ACTOR } from "@/lib/phoenix-crm/server/signboard-holds";
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import type { PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;
type Settings = Pick<PhoenixCrmSettings, "visitFarMeters" | "weakGpsMeters">;

function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

const CUSTOMER_COLUMNS = "id, seat_id, line_code, list_type, name, speciality, status, validated_at, validated_by_hr_id, full_name_held, reference_contact_crm_id";
const PLACE_COLUMNS = "id, customer_id, seat_id, point_source, lat, lon, accuracy_meters, captured_at";
const LOCATION_COLUMNS =
  "id, status, lat, lon, accuracy_meters, address, zone, brick_id, brick_name, brick_distance_km, brick_lookup, area_code, area_name, region_code, region_name";

/**
 * Every "validate this one again" notice ever raised about one customer, by key prefix.
 *
 * Phoenix CRM validation audit, 14 Nov 2026. The word belongs to `validationNotConfirmedKeyPrefix` in
 * server/validation-reviews.ts, which imports this file — so it is restated here rather than imported
 * back, and `tests/phoenix-crm-validation-audit-reviews.test.ts` holds the two equal.
 */
function validateAgainNoticeKeyPrefix(customerId: string): string {
  return `phoenix_crm:validation_not_confirmed:${customerId}:`;
}

/**
 * Answer the rep's "validate again" notice about a customer the system has just validated without him.
 *
 * Phoenix CRM validation audit, 14 Nov 2026: a customer validated from another line (a share), or
 * brought back with his building (server/shared-places.ts, which imports this file and so asks here),
 * kept a bell asking for a photo nobody needs any more. In-app only, like the notice itself; nothing is
 * sent and nobody is told. Never throws: the validation it follows has already happened.
 */
export async function withdrawValidateAgainNoticeQuietly(customerId: string | null | undefined): Promise<void> {
  const id = text(customerId);
  if (!id) return;
  try {
    await withdrawInAppNotificationsByEventKeyPrefix(validateAgainNoticeKeyPrefix(id));
  } catch (error) {
    logError("Phoenix CRM validate-again notice not withdrawn", { labels: { event: "phoenix_crm_validate_again_withdraw_failed" }, error });
  }
}

/** Where to look: one world (real or test), the whole country or the seats of one area. */
type WorldScope = { isTest: boolean; seatIds: string[] | null };

async function readAll(table: string, columns: string, scope: WorldScope, tune: (query: any) => any, what: string): Promise<Row[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const read = await readEveryPage<Row>(
    () => {
      let query = tune(getSupabaseAdmin().from(table).select(columns).eq("is_test", scope.isTest));
      if (scope.seatIds) query = query.in("seat_id", scope.seatIds);
      return query.order("id", { ascending: true });
    },
    { maxRows: 100_000, whenFull: "refuse", what, uniqueBy: (row) => String(row.id), concurrentPages: scope.seatIds ? 1 : 4 },
  );
  throwIfError(read.error);
  return read.rows;
}

/** Every AM and PM row of the scope, with its active places and what each row is waiting on. */
export async function loadTwinWorld(org: OrgIndex, scope: WorldScope): Promise<LineTwinInput> {
  const [customerRows, placeRows, reviewRows, dropRows] = await Promise.all([
    readAll("phoenix_crm_customers", CUSTOMER_COLUMNS, scope, (query) => query.in("list_type", ["AM", "PM"]).in("status", ["active", "pending"]), "The AM and PM customers"),
    readAll("phoenix_crm_places", PLACE_COLUMNS, scope, (query) => query.eq("status", "active"), "The active places"),
    readAll("phoenix_crm_validation_reviews", "id, customer_id, place_id", scope, (query) => query.eq("status", "pending"), "The validations waiting for the Super Admin"),
    readAll("phoenix_crm_list_requests", "id, seat_id, customer_id, reference_contact_crm_id", scope, (query) => query.eq("kind", "drop").eq("status", "pending"), "The drop requests waiting"),
  ]);
  // 🔴 A REVIEW WAITS ONLY WHILE ITS PLACE IS IN USE (owner, 14 Nov 2026, the items the audit left). A
  // rejected building and a place removed from the list leave their pending review pending, and it is
  // nobody's to decide; counted here it kept the row "in review" and out of the line sharing for good.
  // The places are asked by id, never taken from this scope's own places: a review and its place can sit
  // on two territories. A place that could not be read holds the row, as before.
  const reviewedPlaces = await selectByIds<Row>("phoenix_crm_places", "id, status", "id", [...new Set(reviewRows.map((row) => String(row.place_id)))]);
  const reviewedPlaceStatus = new Map(reviewedPlaces.map((row) => [String(row.id), String(row.status)]));
  const inReview = new Set(
    reviewRows.filter((row) => (reviewedPlaceStatus.get(String(row.place_id)) ?? "active") === "active").map((row) => String(row.customer_id)),
  );
  const dropById = new Set(dropRows.map((row) => text(row.customer_id)).filter((id): id is string => id !== null));
  const dropByReference = new Set(dropRows.filter((row) => !text(row.customer_id) && row.reference_contact_crm_id !== null).map((row) => `${row.seat_id}|${row.reference_contact_crm_id}`));

  const customers: TwinCustomer[] = customerRows.map((row) => {
    const seat = org.seats.get(String(row.seat_id));
    const reference = row.reference_contact_crm_id === null || row.reference_contact_crm_id === undefined ? null : String(row.reference_contact_crm_id);
    return {
      id: String(row.id),
      seatId: String(row.seat_id),
      lineCode: seat?.lineCode ?? text(row.line_code),
      areaCode: seat?.areaCode ?? null,
      isTest: scope.isTest,
      listType: String(row.list_type),
      name: String(row.name ?? ""),
      speciality: text(row.speciality),
      status: String(row.status),
      validatedAt: text(row.validated_at),
      validatedByHrId: text(row.validated_by_hr_id),
      pendingReview: inReview.has(String(row.id)),
      pendingDrop: dropById.has(String(row.id)) || (reference !== null && dropByReference.has(`${row.seat_id}|${reference}`)),
      fullNameHeld: text(row.full_name_held) !== null,
    };
  });
  const places: TwinPlace[] = placeRows.flatMap((row) => {
    const lat = numberOrNull(row.lat);
    const lon = numberOrNull(row.lon);
    if (lat === null || lon === null) return [];
    return [
      {
        id: String(row.id),
        customerId: String(row.customer_id),
        seatId: String(row.seat_id),
        pointSource: String(row.point_source ?? "pin"),
        lat,
        lon,
        accuracyMeters: numberOrNull(row.accuracy_meters),
        capturedAt: String(row.captured_at ?? ""),
      },
    ];
  });
  return { customers, places };
}

// ── Carrying out the plan ────────────────────────────────────────────────────────────────────────

export type MergeOutcome = { moved: number; failed: number };

/** Each move goes through the audited `phoenix_crm_move_place`, onto the anchor's stored point and location. */
export async function applyLineTwinMerges(moves: ReadonlyArray<LineTwinMove>, settings: Settings): Promise<MergeOutcome> {
  if (moves.length === 0) return { moved: 0, failed: 0 };
  const anchors = new Map(
    (await selectByIds<Row>("phoenix_crm_places", LOCATION_COLUMNS, "id", [...new Set(moves.map((move) => move.anchorPlaceId))])).map((row) => [String(row.id), row]),
  );
  const outcome: MergeOutcome = { moved: 0, failed: 0 };
  const movedPlaces: string[] = [];
  for (const move of moves) {
    const anchor = anchors.get(move.anchorPlaceId);
    if (!anchor || anchor.status !== "active") {
      outcome.failed += 1;
      continue;
    }
    try {
      await callPhoenixCrm<Row>("phoenix_crm_move_place", {
        p: {
          seat_id: move.seatId,
          actor_hr_id: SIGNBOARD_SYSTEM_ACTOR,
          is_test: move.isTest,
          place_id: move.placeId,
          reason: LINE_TWIN_MOVE_REASON,
          location: {
            lat: anchor.lat,
            lon: anchor.lon,
            accuracy_meters: anchor.accuracy_meters,
            address: anchor.address,
            zone: anchor.zone,
            brick_id: anchor.brick_id,
            brick_name: anchor.brick_name,
            brick_distance_km: anchor.brick_distance_km,
            brick_lookup: anchor.brick_lookup,
            area_code: anchor.area_code,
            area_name: anchor.area_name,
            region_code: anchor.region_code,
            region_name: anchor.region_name,
          },
        },
      });
      outcome.moved += 1;
      movedPlaces.push(move.placeId);
      await restampVisitLocationsQuietly({ seatId: move.seatId, isTest: move.isTest, customerId: move.customerId, actorHrId: SIGNBOARD_SYSTEM_ACTOR, settings, scope: "all" });
    } catch (error) {
      outcome.failed += 1;
      logError("Phoenix CRM line twin place not moved", { labels: { event: "phoenix_crm_line_twin_move_failed" }, error });
    }
  }
  await followLineTwinCopiesQuietly(movedPlaces, settings);
  return outcome;
}

export type ShareOutcome = { validated: number; skipped: Record<string, number>; failed: number; validatedShares: LineTwinShare[] };

export async function applyLineTwinShares(plan: LineTwinSharePlan, settings: Settings): Promise<ShareOutcome> {
  const outcome: ShareOutcome = { validated: 0, skipped: {}, failed: 0, validatedShares: [] };
  for (const share of plan.shares) {
    try {
      const result = await callPhoenixCrm<Row>("phoenix_crm_share_line_validation", {
        p: {
          seat_id: share.seatId,
          customer_id: share.customerId,
          is_test: share.isTest,
          actor_hr_id: SIGNBOARD_SYSTEM_ACTOR,
          source_place_ids: share.sourcePlaceIds,
          validated_by_hr_id: share.validatedByHrId,
        },
      });
      const skipped = text(result?.skipped);
      if (skipped) {
        outcome.skipped[skipped] = (outcome.skipped[skipped] ?? 0) + 1;
        continue;
      }
      outcome.validated += 1;
      outcome.validatedShares.push(share);
      // Phoenix CRM validation audit, 14 Nov 2026: validated from another line, so the bell that asked
      // his own rep for a new photo is answered. A share was the one validation that left it standing.
      await withdrawValidateAgainNoticeQuietly(share.customerId);
      // His visits from before he had a place are measured now, as after any validation.
      await restampVisitLocationsQuietly({ seatId: share.seatId, isTest: share.isTest, customerId: share.customerId, actorHrId: SIGNBOARD_SYSTEM_ACTOR, settings, scope: "unplaced" });
    } catch (error) {
      outcome.failed += 1;
      logError("Phoenix CRM line twin validation not shared", { labels: { event: "phoenix_crm_line_twin_share_failed" }, error });
    }
  }
  return outcome;
}

/**
 * The copies of these places moved (or, with `retired`, were removed) with them in the database
 * (`phoenix_crm_places_line_twin_follow`); their customers' visits are measured again here. A removed
 * source sends its copies' doctors back to To validate, so each is then offered to the twins that are
 * still validated — validated on one line is validated on all three. Never throws.
 */
export async function followLineTwinCopiesQuietly(
  placeIds: ReadonlyArray<string>,
  settings: Settings,
  options: { retired?: boolean } = {},
): Promise<void> {
  try {
    const reshare = new Set<string>();
    for (const part of chunk([...new Set(placeIds)], 100)) {
      const { data, error } = await getSupabaseAdmin()
        .from("phoenix_crm_places")
        .select("id, customer_id, seat_id, is_test")
        .eq("point_source", "line_twin")
        .eq("status", options.retired ? "retired" : "active")
        .in("trusted_basis->>source_place_id", part);
      throwIfError(error);
      for (const row of (data ?? []) as Row[]) {
        await restampVisitLocationsQuietly({
          seatId: String(row.seat_id),
          isTest: row.is_test === true,
          customerId: String(row.customer_id),
          actorHrId: SIGNBOARD_SYSTEM_ACTOR,
          settings,
          scope: "all",
        });
        if (options.retired) reshare.add(String(row.customer_id));
      }
    }
    for (const customerId of reshare) await shareAcrossLinesQuietly(customerId);
  } catch (error) {
    logError("Phoenix CRM line twin copies not re-measured", { labels: { event: "phoenix_crm_line_twin_follow_failed" }, error });
  }
}

// ── After one validation ─────────────────────────────────────────────────────────────────────────

/** Only the rows that could be this doctor: same world, same list, same first two name words. */
function sameNameFamily(input: LineTwinInput, subject: { listType: string; name: string }): LineTwinInput {
  const words = twinNameWords(subject.name);
  const key = `${words[0]} ${words[1]}`;
  const customers = input.customers.filter((customer) => {
    if (customer.listType !== subject.listType) return false;
    const other = twinNameWords(customer.name);
    return other.length >= 2 && `${other[0]} ${other[1]}` === key;
  });
  const ids = new Set(customers.map((customer) => customer.id));
  return { customers, places: input.places.filter((place) => ids.has(place.customerId)) };
}

/**
 * A doctor was just validated on one line: his rows on the other lines of his area follow. Never throws —
 * the validation it follows has already happened and the rep has already been answered.
 */
export async function shareAcrossLinesQuietly(customerId: string | null | undefined): Promise<void> {
  const id = text(customerId);
  if (!id) return;
  try {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, seat_id, list_type, name, is_test, status").eq("id", id).maybeSingle();
    throwIfError(error);
    const row = (data ?? null) as Row | null;
    if (!row || row.status !== "active" || (row.list_type !== "AM" && row.list_type !== "PM")) return;
    if (twinNameWords(String(row.name ?? "")).length < 3) return;
    const org = await loadPhoenixCrmOrg();
    const areaCode = org.seats.get(String(row.seat_id))?.areaCode ?? null;
    if (!areaCode) return;
    const seatIds = [...org.seats.values()].filter((seat) => seat.areaCode === areaCode).map((seat) => seat.seatId);
    const scope: WorldScope = { isTest: row.is_test === true, seatIds };
    const subject = { listType: String(row.list_type), name: String(row.name ?? "") };
    const settings = (await loadPhoenixCrmConfig()).settings;

    const before = sameNameFamily(await loadTwinWorld(org, scope), subject);
    const moves = planLineTwinMerges(before);
    const merged = await applyLineTwinMerges(moves, settings);
    const after = merged.moved > 0 ? sameNameFamily(await loadTwinWorld(org, scope), subject) : before;
    await applyLineTwinShares(planLineTwinShares(after), settings);
  } catch (error) {
    logError("Phoenix CRM validation not shared across the lines", { labels: { event: "phoenix_crm_line_twin_hook_failed" }, error });
  }
}

// ── The whole country, for the ops script ────────────────────────────────────────────────────────

export type LineTwinPass = {
  moves: LineTwinMove[];
  plan: LineTwinSharePlan;
  merged: MergeOutcome | null;
  shared: ShareOutcome | null;
};

/**
 * Dry by default: plans the merges and the shares on the world as it stands. With `apply`, the merges are
 * carried out first, the world is read again, and the shares are planned on it and carried out.
 */
export async function runLineTwinPass(options: { isTest: boolean; apply: boolean }): Promise<LineTwinPass> {
  const org = await loadPhoenixCrmOrg();
  const scope: WorldScope = { isTest: options.isTest, seatIds: null };
  const world = await loadTwinWorld(org, scope);
  const moves = planLineTwinMerges(world);
  if (!options.apply) return { moves, plan: planLineTwinShares(world), merged: null, shared: null };
  const settings = (await loadPhoenixCrmConfig()).settings;
  const merged = await applyLineTwinMerges(moves, settings);
  const plan = planLineTwinShares(merged.moved > 0 ? await loadTwinWorld(org, scope) : world);
  const shared = await applyLineTwinShares(plan, settings);
  return { moves, plan, merged, shared };
}
