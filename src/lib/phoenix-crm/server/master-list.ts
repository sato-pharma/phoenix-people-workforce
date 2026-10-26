/**
 * Phoenix CRM — the Master List: the read and the Super Admin's word (owner, 2026-10-26).
 *
 * The rule is `master-list.ts`; this file is only what feeds it and what stores what he says.
 *
 * 🔴 THE SUPER ADMIN AND THE CEO, NOBODY ELSE — his words: "build a master page for only the admin, and
 * the CEO". The CEO reads; only the Super Admin confirms or picks a photo ("my click and automatic").
 * A rep or a manager never sees it: it sets one rep's readings beside another's, across teams.
 *
 * 🔴 NEVER `seatScoped` HERE. The CEO's scope is every open seat, past the 150-id cap that helper refuses
 * at, so the read takes every active place and keeps the viewer's own seats in memory.
 *
 * 🔴 EVERY READ IS PAGED. Thousands of places and visits; a bare read answers its first 1,000 rows and
 * says nothing.
 *
 * 🔴 NOTHING HERE MOVES A REP'S PLACE. He chose "Master profile only": a decision row names the place
 * whose photo the profile wears and whether it is one place; `phoenix_crm_places` is only ever read.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { cairoTodayIso } from "@/lib/crm/plan-week";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import { personNameWords } from "@/lib/phoenix-crm/signboard-rules";
import {
  buildMasterProfiles,
  TIMING_DAYS,
  type MasterDecision,
  type MasterProfile,
  type MasterSubject,
  type MasterVerdict,
  type MasterVisit,
} from "@/lib/phoenix-crm/master-list";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { matchAnchorOf } from "@/lib/phoenix-crm/server/place-match-groups";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { addDays } from "@/lib/phoenix-crm/visit-report-compute";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

/** The Super Admin and the CEO read it. Named once, so the page, the route and the test say one thing. */
export function canReadMasterList(viewer: Pick<PhoenixCrmViewer, "isSuperAdmin" | "role" | "isTestPersona">): boolean {
  if (viewer.isTestPersona) return false;
  return viewer.isSuperAdmin || viewer.role === "CEO";
}

/** Only the Super Admin confirms, marks not confirmed, or picks the photo. */
export function canDecideMasterList(viewer: Pick<PhoenixCrmViewer, "isSuperAdmin" | "isTestPersona" | "canUpdate">): boolean {
  return !viewer.isTestPersona && viewer.isSuperAdmin && viewer.canUpdate;
}

const PLACE_COLUMNS =
  "id, seat_id, customer_id, address, brick_name, area_name, region_name, lat, lon, accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, " +
  "photo_lat, photo_lon, photo_accuracy_meters, photo_path, created_by_hr_id, created_at";

const VISIT_COLUMNS = "id, customer_id, rep_hr_id, captured_at, visit_date, dwell_seconds, location_flag";

const cairoClock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Africa/Cairo" });

/** Cairo minutes after midnight of an instant, or null when it is not one. */
export function cairoMinuteOf(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const [hour, minute] = cairoClock.format(date).split(":").map(Number);
  return hour * 60 + minute;
}

export type MasterListRead = { profiles: MasterProfile[]; capped: boolean; canDecide: boolean };

export async function loadMasterList(viewer: PhoenixCrmViewer): Promise<MasterListRead> {
  if (!canReadMasterList(viewer)) throw forbiddenError("Only the Super Admin and the CEO read the Master List.");
  const inScope = viewer.isSuperAdmin ? null : new Set(viewer.scopeTerritories.map((seat) => seat.seatId));
  const since = addDays(cairoTodayIso(), -TIMING_DAYS);

  const [placeRead, visitRead, decisionRead] = await Promise.all([
    readEveryPage<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_places")
          .select(PLACE_COLUMNS)
          .eq("status", "active")
          .eq("is_test", false)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
      { maxRows: 20_000, whenFull: "stop", what: "The validated places in use", uniqueBy: (row) => String(row.id) },
    ),
    readEveryPage<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_visits")
          .select(VISIT_COLUMNS)
          .gte("visit_date", since)
          .eq("is_test", false)
          // Never a visit the Super Admin entered for a rep (its time is the one he typed), nor the pharmacy
          // visit a doctor's visit filed beside itself (it carries the doctor visit's own time).
          .neq("capture_source", "admin")
          .is("linked_from_visit_id", null)
          .order("captured_at", { ascending: true })
          .order("id", { ascending: true }),
      { maxRows: 60_000, whenFull: "stop", what: "Three months of visits", uniqueBy: (row) => String(row.id) },
    ),
    readEveryPage<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_master_decisions")
          .select("anchor_place_id, verdict, note, decided_by_hr_id, decided_at")
          .order("anchor_place_id", { ascending: true }),
      { maxRows: 20_000, whenFull: "stop", what: "The Master List decisions", uniqueBy: (row) => String(row.anchor_place_id) },
    ),
  ]);
  throwIfError(placeRead.error);
  throwIfError(visitRead.error);
  throwIfError(decisionRead.error);

  const places = placeRead.rows.filter((row) => !inScope || inScope.has(String(row.seat_id)));
  const customerIds = [...new Set(places.map((row) => String(row.customer_id)))];
  const [customers, names] = await Promise.all([
    selectByIds<Row>("phoenix_crm_customers", "id, name, list_type, speciality", "id", customerIds),
    loadPeopleNames([...places.map((row) => text(row.created_by_hr_id)), ...decisionRead.rows.map((row) => text(row.decided_by_hr_id))]),
  ]);
  const customerById = new Map(customers.map((row) => [String(row.id), row]));

  const subjects: MasterSubject[] = places.map((row) => {
    const customer = customerById.get(String(row.customer_id)) ?? {};
    const seat = viewer.org.seats.get(String(row.seat_id));
    const anchor = matchAnchorOf(row);
    const title = String(customer.name ?? "Unknown customer");
    return {
      placeId: String(row.id),
      customerId: String(row.customer_id),
      seatId: String(row.seat_id),
      title,
      listType: String(customer.list_type ?? ""),
      speciality: text(customer.speciality),
      nameWords: personNameWords(title).map((word) => word.word),
      point: anchor?.point ?? null,
      // The anchor is the photograph's own fix whenever that fix is usable (matchAnchorOf's order).
      pointIsPhoto: isUsableFix(row.photo_lat, row.photo_lon),
      accuracyMeters: anchor?.accuracyMeters ?? null,
      photoPath: text(row.photo_path),
      regionName: text(row.region_name) ?? seat?.regionName ?? null,
      areaName: text(row.area_name) ?? seat?.areaName ?? null,
      brickName: text(row.brick_name),
      address: text(row.address),
      capturedAt: String(row.created_at),
      repName: nameOf(names, text(row.created_by_hr_id), seat ? territoryName(seat) : "A rep"),
      lineName: seat?.lineName ?? null,
    };
  });

  const wanted = new Set(customerIds);
  const visits: MasterVisit[] = visitRead.rows
    .filter((row) => wanted.has(String(row.customer_id)))
    .map((row) => ({
      customerId: String(row.customer_id),
      visitDate: String(row.visit_date),
      minuteOfDay: cairoMinuteOf(row.captured_at),
      dwellSeconds: typeof row.dwell_seconds === "number" ? row.dwell_seconds : row.dwell_seconds == null ? null : Number(row.dwell_seconds),
      atPlace: row.location_flag === "ok",
      repHrId: text(row.rep_hr_id),
    }));

  const decisions: MasterDecision[] = decisionRead.rows.map((row) => ({
    anchorPlaceId: String(row.anchor_place_id),
    verdict: row.verdict === "rejected" ? "rejected" : "confirmed",
    note: text(row.note),
    decidedByName: nameOf(names, text(row.decided_by_hr_id), "the Super Admin"),
    decidedAt: String(row.decided_at),
  }));

  return {
    profiles: buildMasterProfiles({ subjects, visits, decisions }),
    capped: placeRead.capped || visitRead.capped || decisionRead.capped,
    canDecide: canDecideMasterList(viewer),
  };
}

// ── What he says ────────────────────────────────────────────────────────────────────────────────

export const MAX_PROFILE_MEMBERS = 200;

export type MasterDecisionResult = { anchorPlaceId: string; verdict: MasterVerdict | null };

/**
 * Store his word on one profile, or take it back (`verdict: null`).
 *
 * The profile is keyed by the place whose photo it wears. Any earlier decision keyed on ANOTHER of its
 * places is cleared first, so picking a new photo moves the decision instead of leaving two that disagree.
 */
export async function saveMasterDecision(viewer: PhoenixCrmViewer, raw: unknown): Promise<MasterDecisionResult> {
  if (!canDecideMasterList(viewer)) throw forbiddenError("Only the Super Admin confirms the Master List.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  const anchorPlaceId = String(body.anchorPlaceId ?? "");
  if (!isUuid(anchorPlaceId)) throw validationError("That profile does not name a place.");
  const rawMembers = Array.isArray(body.memberPlaceIds) ? (body.memberPlaceIds as unknown[]) : [];
  if (rawMembers.length > MAX_PROFILE_MEMBERS) throw validationError("That profile names too many places.");
  const members = [...new Set([anchorPlaceId, ...rawMembers.map((id) => String(id ?? ""))])];
  if (!members.every(isUuid)) throw validationError("That profile does not name its places.");
  if (body.verdict !== "confirmed" && body.verdict !== "rejected" && body.verdict !== null) {
    throw validationError("Choose confirmed, not confirmed, or clear the decision.");
  }
  const verdict = body.verdict as MasterVerdict | null;
  const note = text(body.note);
  if (note && note.length > 500) throw validationError("Keep the note under 500 characters.");

  const admin = getSupabaseAdmin();
  const { error: clearError } = await admin.from("phoenix_crm_master_decisions").delete().in("anchor_place_id", members);
  throwIfError(clearError);
  if (verdict === null) return { anchorPlaceId, verdict: null };

  const now = new Date().toISOString();
  const { error } = await admin.from("phoenix_crm_master_decisions").insert({
    anchor_place_id: anchorPlaceId,
    member_place_ids: members,
    verdict,
    note,
    decided_by_hr_id: viewer.hrId,
    decided_at: now,
    updated_at: now,
  });
  throwIfError(error);
  return { anchorPlaceId, verdict };
}
