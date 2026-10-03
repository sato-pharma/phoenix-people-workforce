// Phoenix CRM — one field day, read from production.
//
// Returns the day as the papers need it: the three Delta (1) teams, every rep who holds a seat under
// them, each rep's calls and places with their real accuracy readings, and the events of the day in
// order. No judgement and no prose — `print-day.mjs` adds those.
//
// 🔴 EVERY FIGURE IS READ, NEVER TYPED, AND THAT IS THE WHOLE REASON THIS FILE EXISTS. The first cut
// of these papers carried hand-copied numbers, and the day moved three times while they were being
// written — a place captured at 14:07, a doctor seen at 14:17, two more of each by 14:41. A paper
// that reaches the Chief Executive cannot disagree with the screen he opens, and the only way to
// guarantee that is to never let a human retype a number into it.
//
// It reads PRODUCTION through the service role in `.env.local` (AGENTS.md §3: that file points at
// production). Reads only — this never writes a row.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Delta (1)'s three district-manager seats — the teams Phoenix CRM started on 2026-10-03. */
export const TEAM_SEATS = ["SEAT-CNS-DM-D1", "SEAT-PED-DM-D1", "SEAT-AIF-DM-D1"];
/** The order the lines are printed in, which is the order the owner reads them. */
const LINE_ORDER = ["CNS", "Pedia", "Anti Infective"];

/** Cairo is what every time on these papers means (AGENTS.md §4). */
const CAIRO = "Africa/Cairo";
export const cairoClock = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: CAIRO, hour: "2-digit", minute: "2-digit" }) : null;
export const cairoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: CAIRO });
/** The Cairo calendar day an instant falls in — never `toISOString`, which is UTC and rolls at 02:00 here. */
export const cairoDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: CAIRO }) : null);

/** The worse of a place's two readings — the photo's own fix and the separate Capture location pin. */
export const worstReading = (place) =>
  Math.max(Number(place.photo_accuracy_meters ?? 0), Number(place.pin_accuracy_meters ?? 0));

function env() {
  return Object.fromEntries(
    readFileSync(path.join(REPO_ROOT, ".env.local"), "utf8")
      .split(/\r?\n/)
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1).replace(/^["']|["']$/g, "")];
      }),
  );
}

/**
 * PostgREST answers at most 1,000 rows and says nothing when it truncates, so every read that could
 * exceed that — fourteen reps' customer lists are 1,971 rows between them — pages explicitly.
 */
async function all(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export async function readDay(day = cairoToday()) {
  const { createClient } = await import("@supabase/supabase-js");
  const config = env();
  const db = createClient(config.NEXT_PUBLIC_SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const [tree, visits, allPlaces, dayStarts, unplanned, requests] = await Promise.all([
    all(() => db.from("au_v_org_tree").select("seat_id, parent_seat_id, line_name, area_name, occupant_hr_id, is_vacant")),
    all(() =>
      db
        .from("phoenix_crm_visits")
        .select("seat_id, customer_id, list_type, captured_at, location_flag, distance_meters")
        .eq("is_test", false)
        .eq("visit_date", day),
    ),
    all(() =>
      db
        .from("phoenix_crm_places")
        .select("seat_id, customer_id, created_at, status, photo_accuracy_meters, pin_accuracy_meters")
        .eq("is_test", false),
    ),
    all(() => db.from("phoenix_crm_day_starts").select("seat_id, started_at").eq("is_test", false).eq("started_on", day)),
    all(() =>
      db.from("phoenix_crm_unplanned_visits").select("seat_id, customer_id, status, clarification").eq("is_test", false).eq("visit_date", day),
    ),
    all(() => db.from("phoenix_crm_list_requests").select("seat_id, kind, customer_name, requested_at").eq("is_test", false).eq("status", "pending")),
  ]);

  const repSeats = tree.filter((row) => TEAM_SEATS.includes(row.parent_seat_id));
  const dmSeats = tree.filter((row) => TEAM_SEATS.includes(row.seat_id));
  const seatIds = repSeats.filter((row) => !row.is_vacant).map((row) => row.seat_id);

  const [customers, plans, people] = await Promise.all([
    all(() => db.from("phoenix_crm_customers").select("id, seat_id, name, status, validated_at").eq("is_test", false).in("seat_id", seatIds)),
    all(() => db.from("phoenix_crm_plans").select("id, seat_id").eq("is_test", false).in("seat_id", seatIds).in("status", ["submitted", "approved"])),
    all(() =>
      db
        .from("employees")
        .select("hr_id, full_name, job_title")
        .in("hr_id", [...new Set([...repSeats, ...dmSeats].map((row) => row.occupant_hr_id).filter(Boolean))]),
    ),
  ]);
  const planItems = plans.length
    ? await all(() => db.from("phoenix_crm_plan_items").select("plan_id").eq("plan_date", day).in("plan_id", plans.map((plan) => plan.id)))
    : [];

  const names = new Map(people.map((row) => [row.hr_id, row]));
  const customerById = new Map(customers.map((row) => [row.id, row]));
  const places = allPlaces.filter((row) => cairoDate(row.created_at) === day);
  const planSeatOf = new Map(plans.map((plan) => [plan.id, plan.seat_id]));
  const nameOf = (id) => customerById.get(id)?.name ?? "A customer";

  const repOf = (seat) => {
    const mine = (rows) => rows.filter((row) => row.seat_id === seat.seat_id);
    const myVisits = mine(visits);
    const myPlaces = mine(places);
    const myCustomers = customers.filter((row) => row.seat_id === seat.seat_id);
    const readings = myPlaces.map(worstReading).filter(Number.isFinite);
    const events = [
      ...mine(dayStarts).map((row) => ({
        at: cairoClock(row.started_at),
        what: "Started",
        who: "told the manager the day had started",
        how: "pressed in the app",
        sort: row.started_at,
      })),
      ...myVisits.map((row) => ({
        at: cairoClock(row.captured_at),
        what: "Visit",
        who: nameOf(row.customer_id),
        how:
          row.location_flag === "no_place"
            ? "waiting to be measured"
            : row.location_flag === "weak_gps"
              ? `${row.distance_meters} m · weak GPS`
              : row.location_flag === "far"
                ? `${row.distance_meters} m — far`
                : `${row.distance_meters} m from the place`,
        sort: row.captured_at,
      })),
      ...myPlaces.map((row) => ({
        at: cairoClock(row.created_at),
        what: row.status === "retired" ? "Withdrawn" : "Validated",
        who: nameOf(row.customer_id),
        how:
          row.status === "retired"
            ? `${Math.round(worstReading(row)).toLocaleString("en-GB")} m — since withdrawn`
            : `photo ${Math.round(Number(row.photo_accuracy_meters ?? 0))} m · pin ${Math.round(Number(row.pin_accuracy_meters ?? 0))} m`,
        sort: row.created_at,
      })),
    ].sort((left, right) => String(left.sort).localeCompare(String(right.sort)));

    const span = (metres) => `${Math.round(metres).toLocaleString("en-GB")} m`;
    return {
      name: names.get(seat.occupant_hr_id)?.full_name ?? seat.occupant_hr_id,
      title: names.get(seat.occupant_hr_id)?.job_title ?? "",
      area: seat.area_name,
      planned: planItems.filter((item) => planSeatOf.get(item.plan_id) === seat.seat_id).length,
      am: myVisits.filter((row) => row.list_type === "AM").length,
      pm: myVisits.filter((row) => row.list_type === "PM").length,
      places: myPlaces.length,
      kept: myPlaces.filter((row) => row.status === "active").length,
      accuracy:
        readings.length === 0
          ? "—"
          : Math.min(...readings) === Math.max(...readings)
            ? span(Math.min(...readings))
            : `${span(Math.min(...readings))} – ${span(Math.max(...readings))}`.replace(/ m – /, " – "),
      validated: myCustomers.filter((row) => row.validated_at).length,
      list: myCustomers.filter((row) => row.status !== "dropped").length,
      events,
      unplanned: mine(unplanned).map((row) => ({ ...row, customer: nameOf(row.customer_id) })),
      requests: mine(requests).filter((row) => cairoDate(row.requested_at) === day),
      quiet: myVisits.length === 0 && myPlaces.length === 0,
    };
  };

  const groups = dmSeats
    .map((dm) => {
      const seats = repSeats.filter((row) => row.parent_seat_id === dm.seat_id);
      return {
        line: dm.line_name,
        file: dm.line_name.replace(/\s+/g, "-"),
        dm: names.get(dm.occupant_hr_id)?.full_name ?? "(vacant)",
        vacant: seats.filter((row) => row.is_vacant).map((row) => row.area_name),
        // Busiest first: the reps a manager needs to read about are at the top, the quiet ones last.
        reps: seats
          .filter((row) => !row.is_vacant)
          .map(repOf)
          .sort((left, right) => right.places + right.am + right.pm - (left.places + left.am + left.pm)),
      };
    })
    .sort((left, right) => LINE_ORDER.indexOf(left.line) - LINE_ORDER.indexOf(right.line));

  return { day, readAt: cairoClock(new Date().toISOString()), groups, places };
}
