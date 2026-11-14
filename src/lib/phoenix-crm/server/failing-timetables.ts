/**
 * Phoenix CRM — the buildings whose timetable keeps being refused, and the Super Admin's declaration
 * that a building has no timetable. The rule, its numbers and what the declaration does NOT do are in
 * `../failing-timetable-rules.ts`.
 *
 * The list is the deciders' (the Super Admin and the SFE Manager, `canDecideValidationReviews`), on the
 * Polyclinics tab of Place checks. A district manager's board is never handed it.
 *
 * 🔴 THE DECLARATION IS THE SUPER ADMIN'S ALONE (`canDecideSharedPlaces`), and it is one database function
 * that writes the two marker columns and the trail row of who did it. It validates nobody, settles
 * nothing and tells nobody.
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import {
  FAILING_TIMETABLE_LOOKBACK_DAYS,
  FAILING_TIMETABLES_SHOWN,
  failingTimetableSentence,
  failingTimetables,
  type TimetableRefusal,
} from "@/lib/phoenix-crm/failing-timetable-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { canDecideValidationReviews, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, selectByIds, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { canDecideSharedPlaces } from "@/lib/phoenix-crm/server/shared-places";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;

export type FailingTimetableRow = {
  sharedPlaceId: string;
  name: string;
  /** Who captured the building, and on which territory. */
  repName: string;
  territory: string;
  /** "7 timetable photos refused on 3 different days, from 2 people". */
  sentence: string;
  lastRefusedAtText: string;
  /** The building is itself waiting for a decision. */
  held: boolean;
  /** Whether a timetable photograph is on file for it at all. */
  hasTimetable: boolean;
  seated: number;
};

export type FailingTimetablesView = {
  lookbackDays: number;
  /** Every building the rule lists; `rows` is the first `FAILING_TIMETABLES_SHOWN` of them. */
  total: number;
  rows: FailingTimetableRow[];
  /** The refusals read stopped at its ceiling, so the list is a floor. */
  capped: boolean;
};

const EMPTY: FailingTimetablesView = { lookbackDays: FAILING_TIMETABLE_LOOKBACK_DAYS, total: 0, rows: [], capped: false };

/**
 * The buildings in use (or being checked) refused on two or more different days in the window, real
 * entries only. A rejected building and one declared to have no timetable are not listed: the first is
 * not in use, the second is the administrator's exception and not a fault.
 */
export async function loadFailingTimetables(viewer: PhoenixCrmViewer, now: Date = new Date()): Promise<FailingTimetablesView> {
  if (!canDecideValidationReviews(viewer)) return EMPTY;
  const since = new Date(now.getTime() - FAILING_TIMETABLE_LOOKBACK_DAYS * DAY_MS).toISOString();
  const read = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_refused_readings")
        .select("id, shared_place_id, rep_hr_id, visit_date, refused_at")
        .in("reason", ["timetable_unreadable", "timetable_missing"])
        .not("shared_place_id", "is", null)
        .eq("is_test", false)
        .gte("refused_at", since)
        .order("refused_at", { ascending: false })
        .order("id", { ascending: false }),
    { maxRows: 20_000, whenFull: "stop", what: "The refused timetable photos", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  const refusals = read.rows.map(
    (row): TimetableRefusal => ({
      sharedPlaceId: textOrNull(row.shared_place_id),
      repHrId: textOrNull(row.rep_hr_id),
      visitDate: textOrNull(row.visit_date),
      refusedAt: String(row.refused_at),
    }),
  );
  const failing = failingTimetables(refusals);
  if (failing.length === 0) return { ...EMPTY, capped: read.capped };

  const buildings = await selectByIds<Row>(
    "phoenix_crm_shared_places",
    "id, name, status, seat_id, created_by_hr_id, timetable_exempt_at, schedule_photo_path, is_test",
    "id",
    failing.map((building) => building.sharedPlaceId),
  );
  const byId = new Map(buildings.map((row) => [String(row.id), row]));
  const listed = failing.filter((building) => {
    const row = byId.get(building.sharedPlaceId);
    return Boolean(row) && row?.status !== "retired" && !row?.timetable_exempt_at && row?.is_test !== true;
  });
  const shown = listed.slice(0, FAILING_TIMETABLES_SHOWN);

  const [names, seated] = await Promise.all([
    loadPeopleNames(shown.map((building) => textOrNull(byId.get(building.sharedPlaceId)?.created_by_hr_id))),
    selectByIds<Row>(
      "phoenix_crm_places",
      "id, shared_place_id",
      "shared_place_id",
      shown.map((building) => building.sharedPlaceId),
      (query) => query.eq("status", "active"),
    ),
  ]);
  const seatedCount = new Map<string, number>();
  for (const place of seated) seatedCount.set(String(place.shared_place_id), (seatedCount.get(String(place.shared_place_id)) ?? 0) + 1);

  return {
    lookbackDays: FAILING_TIMETABLE_LOOKBACK_DAYS,
    total: listed.length,
    capped: read.capped,
    rows: shown.map((building): FailingTimetableRow => {
      const row = byId.get(building.sharedPlaceId) as Row;
      const seat = viewer.org.seats.get(String(row.seat_id));
      return {
        sharedPlaceId: building.sharedPlaceId,
        name: String(row.name ?? "A building"),
        repName: nameOf(names, textOrNull(row.created_by_hr_id), "A rep"),
        territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
        sentence: failingTimetableSentence(building),
        lastRefusedAtText: formatPhoenixDateTime(building.lastRefusedAt),
        held: row.status === "held",
        hasTimetable: Boolean(textOrNull(row.schedule_photo_path)),
        seated: seatedCount.get(building.sharedPlaceId) ?? 0,
      };
    }),
  };
}

export type NoTimetableDeclaration = { sharedPlaceId: string; name: string; declared: boolean };

/**
 * Declare that one building has no timetable, or take that back.
 *
 * ONE database function, `phoenix_crm_set_shared_place_no_timetable`: it locks the building's row, sets
 * or clears the two marker columns and writes the trail row in the same transaction (owner, 14 Nov 2026:
 * "Record who took back"). So two clicks cannot both land, a building rejected in the meantime is
 * refused, and a take-back keeps who took it back and whose declaration it ended. Nothing else is
 * written: no customer, no review, no notice.
 */
export async function setSharedPlaceNoTimetable(viewer: PhoenixCrmViewer, raw: unknown): Promise<NoTimetableDeclaration> {
  if (!canDecideSharedPlaces(viewer)) throw forbiddenError("Only the Super Admin declares that a building has no timetable.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.sharedPlaceId)) throw validationError("Choose the polyclinic or centre.");
  if (typeof body.declared !== "boolean") throw validationError("Reload the page and try again.");
  const sharedPlaceId = String(body.sharedPlaceId).toLowerCase();
  const declared = body.declared;

  const answer = await callPhoenixCrm<Row | null>("phoenix_crm_set_shared_place_no_timetable", {
    p: { shared_place_id: sharedPlaceId, actor_hr_id: viewer.hrId, declared },
  });
  const outcome = String(answer?.outcome ?? "");
  if (outcome === "written") return { sharedPlaceId, name: String(answer?.name ?? ""), declared };

  // Nothing was written, and the function says which of the three it was.
  if (outcome === "missing") throw notFoundError("This polyclinic or centre is no longer there. Reload the page.");
  if (outcome === "retired") throw conflictError("This building was rejected, so there is nothing to declare on it. Reload the page.");
  if (outcome === "unchanged") {
    throw conflictError(declared ? "This building is already declared to have no timetable. Reload the page." : "This building is not declared to have no timetable. Reload the page.");
  }
  throw new Error(`phoenix_crm_set_shared_place_no_timetable answered an outcome this code does not know: "${outcome}"`);
}
