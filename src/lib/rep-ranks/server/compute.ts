// Phoenix Ranks — the nightly computation. The ONLY file on the scoring path that touches the
// database; everything it reads is handed to the pure builders (rank-facts.ts, scoring.ts).
//
// PHOENIX CRM ONLY (owner, 2026-10-05: "all data in phoenix crm not ever any data from old crm"):
//   * the roster — Phoenix CRM's own territories (`loadPhoenixCrmOrg`), open lines only, seats that
//     have ever carried real Phoenix CRM work (`seatsWithRealActivity`, the 06:55 digest's own gate);
//   * the visits — `phoenix_crm_countable_visits`, real (`is_test = false`), validated customers, the
//     AM and PM lists (Pharmacy is in no KPI);
//   * the lists and grade targets — `phoenix_crm_customers`, `phoenix_crm_settings.grade_targets`;
//   * the plan — `phoenix_crm_report_plan_vs_actual`, leave applied by `groupPlanByTerritory`;
//   * the AM start — the rep's own press, `phoenix_crm_day_starts`;
//   * leave — HR's approved FULL days (`loadApprovedLeaveDays`), which come out of the owed days;
//   * the deeper measures — every save the rep made in the field (any list, its time, fix, products,
//     note) and the silent detectors' STRONG flags on those saves (`phoenix_crm_location_integrity`),
//     minus the cases the Super Admin has SETTLED (owner, 2026-10-09 — `rankCountedFlags`).
//     The flags reach the score as one number and the admin twin's counts, never a portal answer.
// Nothing from iReports360, the KPIs board or Early Birds.
//
// It is computed once a night for everybody, never per viewer. Every read that grows with the field
// is keyset-paged: PostgREST stops at 1,000 rows with no error and no marker.

import { isCallRateWorkingDay } from "@/lib/crm/call-rate";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { addDaysIso, cairoHourMinute } from "@/lib/crm/dates";
import { PHOENIX_CRM_TEAM_STARTS_TABLE, parsePhoenixTeamStart } from "@/lib/crm/phoenix-team-starts";
import { invalidateRepRanksCache } from "@/lib/dashboard/invalidation";
import { hrIdLookupKeys, normalizeHrIdForAccess } from "@/lib/hr-id";
import {
  judgeLaterSignboardReading,
  readStoredSignboardVerdict,
  type StoredSignboardVerdict,
} from "@/lib/phoenix-crm/location-integrity";
import { leaveDayKey } from "@/lib/phoenix-crm/plan-leave";
import { groupPlanByTerritory } from "@/lib/phoenix-crm/report-rules";
import { seatsWithRealActivity } from "@/lib/phoenix-crm/server/daily-digest";
import { callPhoenixCrm, chunk } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { seatOccupants } from "@/lib/phoenix-crm/scope";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPhoenixCrmConfig, openLineCodes } from "@/lib/phoenix-crm/server/settings";
import { PHOENIX_CRM_DEFAULT_SETTINGS } from "@/lib/phoenix-crm/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { quotedInList } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { loadApprovedLeaveDays } from "@/lib/vacation/approved-leave-days";
import { rankCountedFlags, type RankFieldSave, type RankPlaceCase } from "@/lib/rep-ranks/field-quality";
import {
  factsForWindow,
  indexRankData,
  type RankListType,
  type RankPlanDay,
  type RankRawCustomer,
  type RankRawData,
  type RankRawVisit,
  type RankRosterRep,
} from "@/lib/rep-ranks/rank-facts";
import { rankWindow, REP_RANKS_SCORING_VERSION, type RankStanding } from "@/lib/rep-ranks/scoring";
import { daysBetween, dayWindowOf, monthWindowOf, weekStartOf, weekWindowOf, windowsForAnchor, type RankWindow } from "@/lib/rep-ranks/windows";

const UPSERT_CHUNK = 500;

export const REP_RANKS_JOB_SLUG = "phoenix-rep-ranks";

function db() {
  return getSupabaseAdmin();
}

const keyOf = (hrId: string | null | undefined): string | null => normalizeHrIdForAccess(hrId);

const isList = (value: unknown): value is RankListType => value === "AM" || value === "PM";

function cairoDayOf(instant: string | null | undefined): string | null {
  if (!instant) return null;
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

async function upsertChunks(table: string, rows: Record<string, unknown>[], onConflict: string): Promise<void> {
  for (let index = 0; index < rows.length; index += UPSERT_CHUNK) {
    const { error } = await db().from(table).upsert(rows.slice(index, index + UPSERT_CHUNK), { onConflict });
    if (error) throw error;
  }
}

// ── Reading Phoenix CRM ─────────────────────────────────────────────────────────────────────────

type SeatOf = {
  seatId: string;
  path: readonly string[];
  occupantKey: string;
  occupantHrId: string;
  /** More than one person sits on the seat (a handover) — each is scored on their OWN visits there. */
  shared: boolean;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
};

async function rosterSeats(todayIso: string): Promise<SeatOf[]> {
  const [org, config] = await Promise.all([loadPhoenixCrmOrg(), loadPhoenixCrmConfig()]);
  const openLines = openLineCodes(config.lineRollout, todayIso);
  // One entry per seat × PERSON: `org.territories` is one per seat and so lost the second occupant of a
  // handover seat — the rep serving notice vanished from the board (2026-10-26).
  const candidates = org.territoryHolders.filter(
    (seat) => Boolean(seat.occupantHrId) && !seat.isOtherPseudoDm && Boolean(seat.lineCode && openLines.has(seat.lineCode)),
  );
  const active = await seatsWithRealActivity([...new Set(candidates.map((seat) => seat.seatId))]);
  return candidates
    .filter((seat) => active.has(seat.seatId))
    .map((seat) => ({
      seatId: seat.seatId,
      path: seat.path,
      occupantKey: keyOf(seat.occupantHrId) ?? "",
      occupantHrId: seat.occupantHrId ?? "",
      shared: seatOccupants(seat).length > 1,
      lineName: seat.lineName,
      areaName: seat.areaName,
      regionName: seat.regionName,
    }))
    .filter((seat) => seat.occupantKey);
}

async function readVisits(seatIds: readonly string[], from: string, to: string): Promise<RankRawVisit[]> {
  const out: RankRawVisit[] = [];
  for (const part of chunk([...seatIds], 100)) {
    const rows = await fetchAllRowsKeyset<{
      id: string;
      seat_id: string;
      rep_hr_id: string | null;
      customer_id: string;
      list_type: string;
      visit_date: string;
      location_flag: string | null;
      capture_source: string | null;
    }>(
      () =>
        db()
          .from("phoenix_crm_countable_visits")
          .select("id, seat_id, rep_hr_id, customer_id, list_type, visit_date, location_flag, capture_source")
          .in("seat_id", part)
          .eq("is_test", false)
          .eq("customer_validated", true)
          // A visit copied from iReports360 history (20261029212200) is the old system's; nothing here judges it.
          .is("imported_from_ireports360_at", null)
          .in("list_type", ["AM", "PM"])
          .gte("visit_date", from)
          .lte("visit_date", to),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
    for (const row of rows) {
      const repKey = keyOf(row.rep_hr_id);
      // A visit with no rep is the manager's own; it is nobody's rank.
      if (!repKey || !isList(row.list_type)) continue;
      // An entry the Super Admin keyed in for a missed record was not saved in the field, so the
      // place check says nothing about the rep.
      const judged = row.capture_source !== "admin" && row.location_flag !== null && row.location_flag !== "no_place";
      out.push({
        repKey,
        seatId: row.seat_id,
        customerId: String(row.customer_id),
        listType: row.list_type,
        day: String(row.visit_date).slice(0, 10),
        located: judged,
        atPlace: judged && row.location_flag === "ok",
      });
    }
  }
  return out;
}

/**
 * The strong integrity flags on each of the reps' saves, keyed by VISIT id, after the
 * approximate-location rule AND after the Super Admin's settlements.
 *
 * 🔴 `subject_kind = "visit"` IS CORRECT HERE AND IS NOT THE WHOLE STORY. The map is keyed by visit
 * id because `readFieldSaves` joins it to the visit row, so a place case has nothing to join to and
 * cannot be widened into this read — it would key on a place id that matches no save and be dropped
 * silently. The place cases are read separately by `readIntegrityPlaceCases` below and counted
 * per-rep; before 2026-10-12 they were not read at all, which is why two detectors never touched a
 * score.
 *
 * 🔴 THE FOUR `settled_*` COLUMNS ARE READ HERE BECAUSE THE TEST IS A COLUMN AGAINST A COLUMN.
 * `settled_flags = flags` is not a filter PostgREST can ask for, and asking only for
 * `settled_at is null` would wrongly keep dropping a case the detectors have since flagged again —
 * the same reason `loadIntegrityCasesForWindow` compares in TypeScript. `rankCountedFlags` is the one
 * place that decides, and it is pure.
 */
async function readIntegrityFlags(seatIds: readonly string[], from: string, to: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const part of chunk([...seatIds], 100)) {
    const rows = await fetchAllRowsKeyset<{
      id: string;
      subject_id: string;
      flags: string[] | null;
      accuracy_meters: number | string | null;
      settled_at: string | null;
      settled_by: string | null;
      settled_note: string | null;
      settled_flags: string[] | null;
    }>(
      () =>
        db()
          .from("phoenix_crm_location_integrity")
          .select("id, subject_id, flags, accuracy_meters, settled_at, settled_by, settled_note, settled_flags")
          .in("seat_id", part)
          .eq("subject_kind", "visit")
          .eq("strong", true)
          .eq("is_test", false)
          .gte("visit_date", from)
          .lte("visit_date", to),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
    for (const row of rows) {
      const accuracy = row.accuracy_meters === null ? null : Number(row.accuracy_meters);
      const counted = rankCountedFlags({
        accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
        flags: row.flags,
        settledAt: row.settled_at,
        settledBy: row.settled_by,
        settledFlags: row.settled_flags,
        settledNote: row.settled_note,
      });
      if (counted.length === 0) continue;
      const key = String(row.subject_id);
      out.set(key, [...new Set([...(out.get(key) ?? []), ...counted])]);
    }
  }
  return out;
}

/**
 * The strong integrity cases filed against a PLACE each rep validated — one row per case, keyed by
 * rep, after the same approximate-location rule and the same settlements a visit case gets.
 *
 * 🔴 THESE REACHED NO SCORE AT ALL UNTIL 2026-10-12. The pillar read `subject_kind = "visit"` only,
 * so the `signboard` and `capture_trust` detectors — both of which file ONLY against places — were
 * silent in Phoenix Ranks for their whole lives: a rep whose validation evidence did not hold up kept
 * a clean Integrity score while a rep flagged on a single visit lost marks.
 *
 * 🔴 KEYED BY REP, NOT BY SUBJECT, AND THAT IS THE WHOLE REASON IT IS A SECOND READ. A place case has
 * no visit to join to, so there is no row for it in `readFieldSaves`; it is counted per rep instead,
 * and `field-quality.ts` adds it to the numerator while the denominator stays field saves.
 *
 * 🔴 `rep_hr_id` GOES THROUGH `keyOf`, LIKE EVERY OTHER PER-REP INDEX IN THIS FILE, AND THAT IS THE
 * WHOLE JOIN. The roster, the saves and the starts are all keyed by `normalizeHrIdForAccess` — lower
 * case with every dash and symbol stripped (`ai0020`, `b170`). This reader upper-cased the raw id
 * instead, so it emitted `AI-0020` and `B-170`: a key that matches no rep on the roster, for every
 * row, which left the pillar widened on paper and counting NOTHING for 9 live cases. The fixture in
 * `tests/rep-ranks.test.ts` could not catch it — it passes canonical keys straight into the pure
 * function, so only the reader's own key was ever wrong.
 *
 * The `settled_*` columns are read for the same column-against-column reason as above.
 *
 * 🔴 AND A CASE A LATER READING HAS WITHDRAWN COSTS NOTHING — the board drops it, so this must too.
 * A signboard flag stands on the reading that filed it, and the nightly pass re-reads the same sign;
 * when it comes back `match` — the sign names this customer after all — the board moves the case to
 * its withdrawn section, where it has NO settle button by design, because nobody has anything left to
 * decide. Read `created_at` and the place's current verdict here and a rep is charged for a finding
 * his own evidence has overturned, with no click anywhere that could ever clear it: the settlement
 * the pillar honours is unreachable for exactly these cases. Measured on production 2026-10-12, the
 * night the pillar first counted place cases at all: three live cases, three reps, all three already
 * withdrawn on the board (`ابراهيم عبدالشافى` re-read `match` at 13:24 Cairo, 38 minutes after the
 * compound-name fix shipped). `judgeLaterSignboardReading` is the board's own rule, unchanged and
 * pure — an `unjudged` re-read still withdraws nothing, and a case with no later reading stands.
 */
async function readIntegrityPlaceCases(seatIds: readonly string[], from: string, to: string): Promise<RankPlaceCase[]> {
  const candidates: Array<{ placeId: string; source: string; filedAt: string | null; flags: string[]; case: RankPlaceCase }> = [];
  for (const part of chunk([...seatIds], 100)) {
    const rows = await fetchAllRowsKeyset<{
      id: string;
      rep_hr_id: string | null;
      subject_id: string | null;
      source: string | null;
      created_at: string | null;
      visit_date: string | null;
      flags: string[] | null;
      accuracy_meters: number | string | null;
      settled_at: string | null;
      settled_by: string | null;
      settled_note: string | null;
      settled_flags: string[] | null;
    }>(
      () =>
        db()
          .from("phoenix_crm_location_integrity")
          .select(
            "id, rep_hr_id, subject_id, source, created_at, visit_date, flags, accuracy_meters, settled_at, settled_by, settled_note, settled_flags",
          )
          .in("seat_id", part)
          .eq("subject_kind", "place")
          .eq("strong", true)
          .eq("is_test", false)
          .gte("visit_date", from)
          .lte("visit_date", to),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
    for (const row of rows) {
      const repKey = keyOf(row.rep_hr_id);
      const day = row.visit_date === null ? "" : String(row.visit_date).slice(0, 10);
      // A case with no rep or no day belongs to nobody's window; it stays on the board, where a human
      // reads it, and never silently lands on the nearest rep.
      if (!repKey || !day) continue;
      const accuracy = row.accuracy_meters === null ? null : Number(row.accuracy_meters);
      const counted = rankCountedFlags({
        accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
        flags: row.flags,
        settledAt: row.settled_at,
        settledBy: row.settled_by,
        settledFlags: row.settled_flags,
        settledNote: row.settled_note,
      });
      if (counted.length === 0) continue;
      candidates.push({
        placeId: String(row.subject_id ?? ""),
        source: String(row.source ?? ""),
        filedAt: row.created_at ? String(row.created_at) : null,
        flags: (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag)),
        case: { repKey, day, flags: counted },
      });
    }
  }
  return dropWithdrawnPlaceCases(candidates);
}

/**
 * Drop the cases a later reading of the same signboard has taken the ground out from under.
 *
 * Only the signboard pass keeps a re-readable verdict anywhere (`judgeLaterSignboardReading` returns
 * null for every other source), so this read is the flagged places' own `signboard_check` and nothing
 * else. 🔴 IT FAILS TOWARDS CHARGING THE CASE: a place whose current verdict could not be read keeps
 * its case counted, which is also where the board leaves it, so the two screens still agree.
 */
async function dropWithdrawnPlaceCases(
  candidates: ReadonlyArray<{ placeId: string; source: string; filedAt: string | null; flags: string[]; case: RankPlaceCase }>,
): Promise<RankPlaceCase[]> {
  const placeIds = [...new Set(candidates.filter((entry) => entry.source === "signboard").map((entry) => entry.placeId).filter(Boolean))];
  const verdicts = new Map<string, StoredSignboardVerdict>();
  for (const part of chunk(placeIds, 50)) {
    const { data, error } = await db().from("phoenix_crm_places").select("id, signboard_check").in("id", part);
    if (error) break;
    for (const place of (data ?? []) as Array<{ id: string; signboard_check: unknown }>) {
      const stored = readStoredSignboardVerdict(place.signboard_check);
      if (stored) verdicts.set(String(place.id), stored);
    }
  }
  return candidates
    .filter((entry) => {
      const later = judgeLaterSignboardReading({
        source: entry.source,
        flags: entry.flags,
        filedAt: entry.filedAt,
        stored: verdicts.get(entry.placeId) ?? null,
      });
      return later === null || !later.withdrawsFlag;
    })
    .map((entry) => entry.case);
}

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Every save the reps made in the field — any list, validated customer or not — for the deeper measures. */
async function readFieldSaves(seatIds: readonly string[], from: string, to: string): Promise<RankFieldSave[]> {
  const flagsByVisit = await readIntegrityFlags(seatIds, from, to);
  const out: RankFieldSave[] = [];
  for (const part of chunk([...seatIds], 100)) {
    const rows = await fetchAllRowsKeyset<{
      id: string;
      rep_hr_id: string | null;
      list_type: string;
      visit_date: string;
      captured_at: string | null;
      lat: number | null;
      lon: number | null;
      accuracy_meters: number | string | null;
      products: unknown[] | null;
      comment: string | null;
      voice_note_path: string | null;
      capture_source: string | null;
    }>(
      () =>
        db()
          .from("phoenix_crm_countable_visits")
          .select("id, rep_hr_id, list_type, visit_date, captured_at, lat, lon, accuracy_meters, products, comment, voice_note_path, capture_source")
          .in("seat_id", part)
          .eq("is_test", false)
          // A visit copied from iReports360 history (20261029212200) is the old system's; nothing here judges it.
          .is("imported_from_ireports360_at", null)
          .gte("visit_date", from)
          .lte("visit_date", to),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
    for (const row of rows) {
      const repKey = keyOf(row.rep_hr_id);
      const capturedAt = row.captured_at ? new Date(row.captured_at).getTime() : Number.NaN;
      // An admin-keyed entry was not saved in the field: its clock and fix say nothing about the rep.
      if (!repKey || row.capture_source === "admin" || Number.isNaN(capturedAt)) continue;
      if (row.list_type !== "AM" && row.list_type !== "PM" && row.list_type !== "Pharmacy") continue;
      const accuracy = finiteOrNull(row.accuracy_meters);
      out.push({
        repKey,
        day: String(row.visit_date).slice(0, 10),
        listType: row.list_type,
        capturedAt,
        lat: finiteOrNull(row.lat),
        lon: finiteOrNull(row.lon),
        accuracyMeters: accuracy,
        products: Array.isArray(row.products) ? row.products.length : 0,
        hasNote: (row.comment ?? "").trim().length >= 3 || Boolean(row.voice_note_path),
        integrityFlags: flagsByVisit.get(String(row.id)) ?? [],
      });
    }
  }
  return out;
}

async function readCustomers(seatIds: readonly string[]): Promise<RankRawCustomer[]> {
  const out: RankRawCustomer[] = [];
  for (const part of chunk([...seatIds], 100)) {
    const rows = await fetchAllRowsKeyset<{
      id: string;
      seat_id: string;
      list_type: string;
      grade: string | null;
      status: string | null;
      status_changed_at: string | null;
    }>(
      () =>
        db()
          .from("phoenix_crm_customers")
          .select("id, seat_id, list_type, grade, status, status_changed_at")
          .in("seat_id", part)
          .eq("is_test", false)
          .not("validated_at", "is", null)
          .in("list_type", ["AM", "PM"]),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
    for (const row of rows) {
      if (!isList(row.list_type)) continue;
      out.push({
        id: String(row.id),
        seatId: row.seat_id,
        listType: row.list_type,
        grade: row.grade ? String(row.grade).trim().toUpperCase() : null,
        active: row.status === "active",
        statusChangedDay: cairoDayOf(row.status_changed_at),
      });
    }
  }
  return out;
}

async function readPlanDays(seatIds: readonly string[], from: string, to: string, leaveBySeatDay: ReadonlySet<string>): Promise<RankPlanDay[]> {
  const out: RankPlanDay[] = [];
  for (const part of chunk([...seatIds], 100)) {
    const rows = await callPhoenixCrm<unknown>("phoenix_crm_report_plan_vs_actual", {
      p_seat_ids: part,
      p_from: from,
      p_to: to,
      p_include_test: false,
    });
    const { groups } = groupPlanByTerritory(Array.isArray(rows) ? rows : [], leaveBySeatDay);
    for (const group of groups) {
      for (const day of group.days) {
        out.push({
          seatId: group.seatId,
          day: day.date,
          planned: day.am.planned + day.pm.planned,
          kept: day.am.visitedPlanned + day.pm.visitedPlanned,
        });
      }
    }
  }
  return out;
}

async function readStarts(seatIds: readonly string[], from: string, to: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  for (const part of chunk([...seatIds], 100)) {
    const rows = await fetchAllRowsKeyset<{ id: string; rep_hr_id: string | null; started_on: string; started_at: string }>(
      () =>
        db()
          .from("phoenix_crm_day_starts")
          .select("id, rep_hr_id, started_on, started_at")
          .in("seat_id", part)
          .eq("is_test", false)
          .gte("started_on", from)
          .lte("started_on", to),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
    for (const row of rows) {
      const repKey = keyOf(row.rep_hr_id);
      const at = new Date(row.started_at);
      if (!repKey || Number.isNaN(at.getTime())) continue;
      const { hour, minute } = cairoHourMinute(at);
      const days = out.get(repKey) ?? new Map<string, number>();
      days.set(String(row.started_on).slice(0, 10), hour * 60 + minute);
      out.set(repKey, days);
    }
  }
  return out;
}

async function readTeamStarts(): Promise<Map<string, string>> {
  const { data, error } = await db().from(PHOENIX_CRM_TEAM_STARTS_TABLE).select("*");
  if (error) throw error;
  const starts = new Map<string, string>();
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const start = parsePhoenixTeamStart(raw);
    if (start && !start.stopsOn) starts.set(start.teamSeatId, start.startsOn);
  }
  return starts;
}

async function readHireDays(hrIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Every casing an HR id is stored under — a plain `.in` on mixed-case ids silently under-returns.
  const lookup = [...new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId)))];
  for (const part of chunk(lookup, 200)) {
    const { data, error } = await db().from("employees").select("hr_id, hire_date").in("hr_id", part);
    if (error) throw error;
    for (const row of (data ?? []) as { hr_id: string; hire_date: string | null }[]) {
      const key = keyOf(row.hr_id);
      if (key && row.hire_date) out.set(key, String(row.hire_date).slice(0, 10));
    }
  }
  return out;
}

/** A rep on a team that was never started owes days from their first real Phoenix CRM visit. */
async function readFirstVisitDayOf(seatIds: readonly string[], hrId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("phoenix_crm_countable_visits")
    .select("visit_date")
    .in("seat_id", [...seatIds])
    .in("rep_hr_id", hrIdLookupKeys(hrId))
    .eq("is_test", false)
    // A copied iReports360 visit (20261029212200) is months before Phoenix: owed days start at the first REAL one.
    .is("imported_from_ireports360_at", null)
    .order("visit_date", { ascending: true })
    .limit(1);
  if (error) throw error;
  const first = (data ?? [])[0] as { visit_date?: string } | undefined;
  return first?.visit_date ? String(first.visit_date).slice(0, 10) : null;
}

function monthEnd(day: string): string {
  const [year, month] = day.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${day.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

/** Everything every window inside [from, to] needs, read once. */
export async function loadRankData(from: string, to: string, todayIso: string): Promise<RankRawData> {
  const seats = await rosterSeats(todayIso);
  const seatIds = [...new Set(seats.map((seat) => seat.seatId))];
  const occupantHrIds = [...new Set(seats.map((seat) => seat.occupantHrId))];

  const holidayFrom = `${from.slice(0, 7)}-01`;
  const [holidays, teamStarts, hireDays, names, settingsRow, leaveRows] = await Promise.all([
    loadCallRateHolidays(holidayFrom, monthEnd(to)),
    readTeamStarts(),
    readHireDays(occupantHrIds),
    loadPeopleNames(occupantHrIds),
    db().from("phoenix_crm_settings").select("grade_targets").eq("id", 1).maybeSingle(),
    // FULL days only; a failed read THROWS — a rank that did not know who was on leave would mark
    // a rep down for days they were not owed, and the dead-man's switch must see that run fail.
    loadApprovedLeaveDays(occupantHrIds, { from, to }),
  ]);
  if (settingsRow.error) throw settingsRow.error;

  const leave = new Set<string>();
  const leaveBySeatDay = new Set<string>();
  const seatsByKey = new Map<string, SeatOf[]>();
  for (const seat of seats) seatsByKey.set(seat.occupantKey, [...(seatsByKey.get(seat.occupantKey) ?? []), seat]);
  for (const row of leaveRows) {
    if (!row.fullDay) continue;
    const key = keyOf(row.hrId);
    if (!key) continue;
    leave.add(`${key}|${row.day}`);
    for (const seat of seatsByKey.get(key) ?? []) leaveBySeatDay.add(leaveDayKey(seat.seatId, row.day));
  }

  const roster: RankRosterRep[] = [];
  for (const [key, repSeats] of seatsByKey) {
    const first = repSeats[0];
    const teamStart = repSeats
      .map((seat) => seat.path.map((seatId) => teamStarts.get(seatId)).find(Boolean) ?? null)
      .filter((day): day is string => Boolean(day))
      .sort()[0];
    let startDay = teamStart ?? (await readFirstVisitDayOf(repSeats.map((seat) => seat.seatId), first.occupantHrId));
    if (!startDay) continue; // an active seat whose occupant has never visited and whose team never started
    const hired = hireDays.get(key);
    if (hired && hired > startDay) startDay = hired;
    roster.push({
      hrIdKey: key,
      repName: nameOf(names, first.occupantHrId),
      lineName: first.lineName,
      areaName: first.areaName,
      regionName: first.regionName,
      seatIds: repSeats.map((seat) => seat.seatId),
      sharedSeatIds: repSeats.filter((seat) => seat.shared).map((seat) => seat.seatId),
      startDay,
    });
  }

  const rawTargets = (settingsRow.data?.grade_targets ?? {}) as Record<string, Record<string, unknown>>;
  const gradeTargets = { AM: {}, PM: {} } as Record<RankListType, Record<string, number | null>>;
  for (const list of ["AM", "PM"] as const) {
    for (const [grade, value] of Object.entries(rawTargets[list] ?? {})) {
      const parsed = value === null || value === "" ? null : Number(value);
      gradeTargets[list][grade.toUpperCase()] = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    }
  }

  const [visits, saves, placeCases, customers, planDays, starts] = await Promise.all([
    readVisits(seatIds, from, to),
    readFieldSaves(seatIds, from, to),
    readIntegrityPlaceCases(seatIds, from, to),
    readCustomers(seatIds),
    readPlanDays(seatIds, from, to, leaveBySeatDay),
    readStarts(seatIds, from, to),
  ]);

  return {
    roster,
    visits,
    saves,
    placeCases,
    customers,
    planDays,
    starts,
    leave,
    holidays: holidays.dates,
    gradeTargets,
    // Phoenix CRM's locked call-rate targets — AM 2, PM 10 (types.ts), never a column.
    callRateTargets: { am: PHOENIX_CRM_DEFAULT_SETTINGS.callRateAmTarget, pm: PHOENIX_CRM_DEFAULT_SETTINGS.callRatePmTarget },
  };
}

// ── Writing one window ──────────────────────────────────────────────────────────────────────────

/** The raw counts behind each score — the admin twin's columns, never sent to a portal page. */
function metricsOf(standing: RankStanding): Record<string, unknown> {
  const facts = standing.facts;
  return {
    owedDays: facts.owedDays,
    amVisits: facts.amVisits,
    pmVisits: facts.pmVisits,
    fieldDays: facts.fieldDays,
    listed: facts.coverage?.listed ?? null,
    covered: facts.coverage?.covered ?? null,
    coveragePct: facts.coverage?.pct ?? null,
    frequencyPct: facts.frequency?.pct ?? null,
    frequencyRequired: facts.frequency?.required ?? null,
    frequencyMet: facts.frequency?.met ?? null,
    planned: facts.plan.planned,
    kept: facts.plan.kept,
    medianStartMinutes: facts.start.medianMinutes,
    startDays: facts.start.days,
    located: facts.accuracy.located,
    atPlace: facts.accuracy.atPlace,
    gapPairs: facts.quality.gaps.pairs,
    gapMedianMinutes: facts.quality.gaps.medianGapMinutes,
    gapMedianWalkMinutes: facts.quality.gaps.medianWalkMinutes,
    gapTooFast: facts.quality.gaps.tooFast,
    gapTooSlow: facts.quality.gaps.tooSlow,
    doctorVisits: facts.quality.products.visits,
    productsDiscussed: facts.quality.products.total,
    withNote: facts.quality.notes.withNote,
    gpsFixes: facts.quality.gps.fixes,
    gpsMedianMeters: facts.quality.gps.medianMeters,
    fieldSaves: facts.quality.integrity.saves,
    flaggedSaves: facts.quality.integrity.flagged,
    // Kept beside `flaggedSaves` rather than folded into it: the two are different acts — a visit
    // saved somewhere it was not, and a place validated on evidence that did not hold up — and the
    // admin twin says which, so a number on his screen is never a sum of two unlike things.
    flaggedPlaces: facts.quality.integrity.places,
    integrityFlags: facts.quality.integrity.flags,
  };
}

async function writeWindow(window: RankWindow, standings: readonly RankStanding[]): Promise<number> {
  const computedAt = new Date().toISOString();
  await upsertChunks(
    "rep_rank_standings",
    standings.map((standing) => ({
      window_kind: window.kind,
      window_key: window.key,
      hr_id_key: standing.hrIdKey,
      window_from: window.from,
      window_to: window.to,
      rep_name: standing.repName,
      line_name: standing.lineName,
      area_name: standing.areaName,
      region_name: standing.regionName,
      ranked: standing.ranked,
      unranked_reason: standing.unrankedReason,
      company_position: standing.companyPosition,
      company_count: standing.companyCount,
      line_position: standing.linePosition,
      line_count: standing.lineCount,
      total_score: standing.total,
      pillars: standing.pillars,
      metrics: metricsOf(standing),
      scoring_version: REP_RANKS_SCORING_VERSION,
      computed_at: computedAt,
    })),
    "window_kind,window_key,hr_id_key",
  );
  // A rep who is no longer on the roster leaves the window too; an empty roster empties it.
  let remove = db().from("rep_rank_standings").delete().eq("window_kind", window.kind).eq("window_key", window.key);
  const keep = standings.map((standing) => standing.hrIdKey);
  if (keep.length > 0) remove = remove.not("hr_id_key", "in", `(${quotedInList(keep)})`);
  const { error } = await remove;
  if (error) throw error;
  return standings.filter((standing) => standing.ranked).length;
}

export type RepRanksRunResult = {
  anchor: string;
  reps: number;
  windows: { kind: string; key: string; ranked: number }[];
};

/** Reads Phoenix CRM once over every window's span, then scores and stores each window. */
export async function rebuildWindows(windows: readonly RankWindow[], todayIso: string): Promise<Omit<RepRanksRunResult, "anchor">> {
  const live = windows.filter((window) => window.from <= window.to);
  if (live.length === 0) return { reps: 0, windows: [] };
  const from = live.map((window) => window.from).sort()[0];
  const to = live.map((window) => window.to).sort().reverse()[0];
  const data = await loadRankData(from, to, todayIso);
  const indexed = indexRankData(data);
  const written: RepRanksRunResult["windows"] = [];
  for (const window of live) {
    const standings = rankWindow(factsForWindow(data, window, indexed), window.kind);
    written.push({ kind: window.kind, key: window.key, ranked: await writeWindow(window, standings) });
  }
  // The board and the profiles are remembered for an hour (read.ts); the one writer drops them, so the
  // morning's first open reads tonight's standings.
  invalidateRepRanksCache(`rep ranks rebuilt: ${written.map((window) => `${window.kind}/${window.key}`).join(", ")}`);
  return { reps: data.roster.length, windows: written };
}

/** Every window that holds YESTERDAY (the call rate's ruling C1) — day, week, month, quarter, semester. */
export async function runRepRanksNightly(input: { todayIso: string }): Promise<RepRanksRunResult> {
  const anchor = addDaysIso(input.todayIso, -1);
  const holidays = await loadCallRateHolidays(addDaysIso(anchor, -21), anchor);
  return { anchor, ...(await rebuildWindows(windowsForAnchor(anchor, holidays.dates), input.todayIso)) };
}

/**
 * Builds a past month in full — every working day, every week that touches it, and the month — so a
 * rep's timeline does not begin on the deploy date. The next nightly run rebuilds the quarter and
 * the semester.
 */
export async function backfillRepRanksMonth(input: { month: string; todayIso: string }): Promise<RepRanksRunResult> {
  const yesterday = addDaysIso(input.todayIso, -1);
  const monthWindow = monthWindowOf(`${input.month}-01`, yesterday);
  const holidays = await loadCallRateHolidays(weekStartOf(monthWindow.from), monthWindow.to);
  const windows: RankWindow[] = [monthWindow];
  const weekKeys = new Set<string>();
  for (const day of daysBetween(monthWindow.from, monthWindow.to)) {
    if (isCallRateWorkingDay(day, holidays.dates)) windows.push(dayWindowOf(day));
    const week = weekWindowOf(day, yesterday);
    if (!weekKeys.has(week.key)) {
      weekKeys.add(week.key);
      windows.push(week);
    }
  }
  return { anchor: monthWindow.to, ...(await rebuildWindows(windows, input.todayIso)) };
}
