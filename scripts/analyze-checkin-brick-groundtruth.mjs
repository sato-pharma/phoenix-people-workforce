// GPS ground truth for SoS geography — READ-ONLY analysis over iReports360 check-ins.
//
// Compares real field GPS (rep check-ins, last N days) against the stored brick centroids in
// geo_locations, using TODAY's seat-model geography (the owner's standing SoS attribution rule):
//   1. per-brick: median check-in coordinate vs stored pin → divergence ranking;
//   2. per-rep:   day-median points closer to a NEIGHBOUR area's centre than their own
//                 (thresholds copied from territory-management's orphan/overlap rules:
//                 own > 12 km AND nearest-other * 1.75 < own);
//   3. pin hygiene: shared pins (multiple bricks on one coordinate).
//
// Both mapping punch-lists (region→brick, customer→brick) were EMPTY when this was built
// (2026-08-02), so the anchor is the rep's own assigned area — not contact-level labels. If those
// tables ever get filled, a contact-labeled pass becomes possible and strictly better.
//
// Outputs (no database writes, ever):
//   scripts/output/gps-groundtruth-report.md          — human report
//   scripts/output/gps-groundtruth-corrections.sql    — PROPOSED pin updates; review + apply
//                                                       manually after owner approval, never here.
//
// Run: node scripts/analyze-checkin-brick-groundtruth.mjs   (needs PHOENIX_PRODUCTION_DATABASE_URL
// in .env.local / environment, same convention as resolve-brick-pins.mjs; connects via the pooler —
// the direct db host is IPv6-only.)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";

import { refuseArguments } from "./lib/refuse-arguments.mjs";

// This script takes no arguments, so it says so instead of ignoring one (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "analyze-checkin-brick-groundtruth",
  usage: `analyze-checkin-brick-groundtruth: compare real field GPS against the stored brick pins.

  node scripts/analyze-checkin-brick-groundtruth.mjs   run the analysis and write its report
  node scripts/analyze-checkin-brick-groundtruth.mjs -h   this text

It takes no arguments: the window, the thresholds and the output path are constants at the top of
the file, and it reads the database named by .env.production.rls.local / .env.local.`,
  hints: [
    "the window and thresholds are constants in this file — edit them, do not pass them",
  ],
});

const WINDOW_DAYS = 60;
const MIN_CHECKINS_PER_BRICK = 20;
const DIVERGENCE_PROPOSAL_KM = 3;
// Same lookup order as resolve-brick-pins.mjs — the DB URLs live in the *.rls.local files.
const ENV_FILES = [".env.staging.rls.local", ".env.production.rls.local", ".env.local"];

function envVar(name) {
  if (process.env[name]) return process.env[name];
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  throw new Error(`${name} is not set (checked env + ${ENV_FILES.join(", ")})`);
}

// Same rewrite as resolve-brick-pins.mjs — the direct db.<ref>.supabase.co host is IPv6-only.
function toPooler(raw) {
  const m = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  if (!m) return raw;
  const [, scheme, user, pass, ref, , db] = m;
  return `${scheme}://${user}.${ref}:${pass}@aws-0-eu-central-1.pooler.supabase.com:5432/${db}`;
}

const sql = postgres(toPooler(envVar("PHOENIX_PRODUCTION_DATABASE_URL")), { max: 2, prepare: false });

const HAVERSINE = (aLat, aLon, bLat, bLon) =>
  `2*6371*asin(sqrt(power(sin(radians((${aLat}-${bLat})/2)),2)+cos(radians(${bLat}))*cos(radians(${aLat}))*power(sin(radians((${aLon}-${bLon})/2)),2)))`;

async function main() {
  // ── 1. Per-brick divergence: median own-area check-in vs stored pin ──────────────────────────
  const divergence = await sql.unsafe(`
    with rep_area as (
      select lam.area_code, upper(au.f_seat_occupant_asof(lam.rep_seat_id, current_date)) as hr_id
      from au.f_line_area_map_asof(current_date) lam
      where lam.rep_seat_id is not null
    ),
    brick_pins as (
      select b.brick_id, b.brick_name, b.area_code, g.latitude as pin_lat, g.longitude as pin_lon,
        g.geocode_provider, g.geocode_status
      from source_of_sales_bricks b
      join geo_locations g on g.source_type='brick_centroid' and g.source_key = b.brick_id
      where b.active and g.latitude is not null
    ),
    own_checkins as (
      select c.lat, c.lon, ra.area_code
      from ireports360_checkins c
      join rep_area ra on ra.hr_id = upper(c.agent_hr_id)
      where c.check_date >= current_date - ${WINDOW_DAYS}
        and c.lat between 21.5 and 32.0 and c.lon between 24.5 and 37.0
    ),
    assigned as (
      select oc.lat, oc.lon, nb.brick_id
      from own_checkins oc
      cross join lateral (
        select bp.brick_id, ${HAVERSINE("oc.lat", "oc.lon", "bp.pin_lat", "bp.pin_lon")} as km
        from brick_pins bp where bp.area_code = oc.area_code
        order by 2 asc limit 1
      ) nb
    ),
    per_brick as (
      select brick_id, count(*) as checkins,
        percentile_cont(0.5) within group (order by lat) as med_lat,
        percentile_cont(0.5) within group (order by lon) as med_lon
      from assigned group by brick_id having count(*) >= ${MIN_CHECKINS_PER_BRICK}
    )
    select p.brick_id, bp.brick_name, bp.area_code, p.checkins::int,
      round((${HAVERSINE("p.med_lat", "p.med_lon", "bp.pin_lat", "bp.pin_lon")})::numeric, 2) as divergence_km,
      bp.geocode_provider, bp.geocode_status,
      round(p.med_lat::numeric, 5) as gps_lat, round(p.med_lon::numeric, 5) as gps_lon
    from per_brick p join brick_pins bp using (brick_id)
    order by (${HAVERSINE("p.med_lat", "p.med_lon", "bp.pin_lat", "bp.pin_lon")}) * p.checkins desc
  `);

  // ── 2. Out-of-territory rep-days (interpret AFTER pin correction — see report note) ──────────
  const outOfTerritory = await sql.unsafe(`
    with rep_area as (
      select lam.area_code, upper(au.f_seat_occupant_asof(lam.rep_seat_id, current_date)) as hr_id
      from au.f_line_area_map_asof(current_date) lam
      where lam.rep_seat_id is not null
    ),
    area_centres as (
      select b.area_code, avg(g.latitude) as lat, avg(g.longitude) as lon
      from source_of_sales_bricks b
      join geo_locations g on g.source_type='brick_centroid' and g.source_key = b.brick_id
      where b.active and g.latitude is not null
      group by b.area_code
    ),
    rep_days as (
      select upper(c.agent_hr_id) as hr_id, c.check_date::date as day,
        percentile_cont(0.5) within group (order by c.lat) as lat,
        percentile_cont(0.5) within group (order by c.lon) as lon
      from ireports360_checkins c
      where c.check_date >= current_date - ${WINDOW_DAYS} and c.agent_hr_id is not null
        and c.lat between 21.5 and 32.0 and c.lon between 24.5 and 37.0
      group by 1, 2
    ),
    scored as (
      select rd.hr_id, ra.area_code as own_area,
        ${HAVERSINE("rd.lat", "rd.lon", "oc.lat", "oc.lon")} as own_km,
        nearest.area_code as nearest_area, nearest.km as nearest_km
      from rep_days rd
      join rep_area ra on ra.hr_id = rd.hr_id
      join area_centres oc on oc.area_code = ra.area_code
      cross join lateral (
        select ac.area_code, ${HAVERSINE("rd.lat", "rd.lon", "ac.lat", "ac.lon")} as km
        from area_centres ac where ac.area_code <> ra.area_code
        order by 2 asc limit 1
      ) nearest
    )
    select s.hr_id, coalesce(nullif(trim(e.full_name), ''), s.hr_id) as rep_name, s.own_area,
      count(*)::int as field_days,
      count(*) filter (where own_km > 12 and nearest_km * 1.75 < own_km)::int as flagged_days,
      round(avg(own_km)::numeric, 1) as avg_own_km,
      mode() within group (order by nearest_area) filter (where own_km > 12 and nearest_km * 1.75 < own_km) as usual_other_area
    from scored s
    left join employees e on upper(e.hr_id) = s.hr_id
    group by 1, 2, 3
    having count(*) filter (where own_km > 12 and nearest_km * 1.75 < own_km) > 0
    order by flagged_days desc
  `);

  // ── 3. Shared pins ───────────────────────────────────────────────────────────────────────────
  const [pinHygiene] = await sql.unsafe(`
    with pins as (
      select g.latitude, g.longitude, count(*) as bricks_on_pin
      from geo_locations g
      join source_of_sales_bricks b on b.brick_id = g.source_key and b.active
      where g.source_type='brick_centroid' and g.latitude is not null
      group by 1, 2
    )
    select
      (select count(*) from source_of_sales_bricks where active)::int as active_bricks,
      (select count(*) from pins where bricks_on_pin > 1)::int as shared_pins,
      coalesce((select sum(bricks_on_pin) from pins where bricks_on_pin > 1), 0)::int as bricks_on_shared_pins,
      (select max(bricks_on_pin) from pins)::int as worst_pin
  `);

  mkdirSync("scripts/output", { recursive: true });

  const proposals = divergence.filter((row) => Number(row.divergence_km) >= DIVERGENCE_PROPOSAL_KM);
  const correctionsSql = [
    "-- PROPOSED brick-pin corrections from check-in GPS medians — REVIEW, get owner approval,",
    `-- and apply manually. Generated ${new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date())} by analyze-checkin-brick-groundtruth.mjs; NEVER auto-executed.`,
    ...proposals.map(
      (row) =>
        `update geo_locations set latitude = ${row.gps_lat}, longitude = ${row.gps_lon}, geocode_provider = 'checkin_gps', geocode_status = 'success', updated_at = now() where source_type = 'brick_centroid' and source_key = '${row.brick_id}'; -- ${row.brick_name} (${row.area_code}): ${row.divergence_km} km off, ${row.checkins} check-ins`,
    ),
  ].join("\n");

  const report = [
    "# GPS Ground Truth — generated report",
    "",
    `Window: last ${WINDOW_DAYS} days · attribution: today's seat-model geography · read-only.`,
    "",
    `## Pin hygiene: ${pinHygiene.active_bricks} active bricks, ${pinHygiene.shared_pins} shared pins carrying ${pinHygiene.bricks_on_shared_pins} bricks (worst: ${pinHygiene.worst_pin}).`,
    "",
    `## Brick pins vs field GPS (≥${MIN_CHECKINS_PER_BRICK} check-ins, ranked by km × volume)`,
    "",
    "| Brick | Area | Check-ins | Divergence km | Provider | GPS median |",
    "|---|---|---|---|---|---|",
    ...divergence.map(
      (row) =>
        `| ${row.brick_name} (${row.brick_id}) | ${row.area_code} | ${row.checkins} | ${row.divergence_km} | ${row.geocode_provider} | ${row.gps_lat}, ${row.gps_lon} |`,
    ),
    "",
    "## Rep-days closer to a neighbour area's centre (interpret AFTER correcting the pins above —",
    "## a wrong pin drags its area's centre and flags innocent reps; see AB4/الرحمانيه)",
    "",
    "| Rep | Area | Field days | Flagged | Avg own km | Usually toward |",
    "|---|---|---|---|---|---|",
    ...outOfTerritory.map(
      (row) =>
        `| ${row.rep_name} | ${row.own_area} | ${row.field_days} | ${row.flagged_days} | ${row.avg_own_km} | ${row.usual_other_area} |`,
    ),
    "",
    `Proposed corrections (divergence ≥ ${DIVERGENCE_PROPOSAL_KM} km): ${proposals.length} — see gps-groundtruth-corrections.sql (NOT applied).`,
  ].join("\n");

  writeFileSync("scripts/output/gps-groundtruth-report.md", report);
  writeFileSync("scripts/output/gps-groundtruth-corrections.sql", correctionsSql);
  console.log(
    `[gps-groundtruth] ${divergence.length} bricks measured, ${proposals.length} corrections proposed, ` +
      `${outOfTerritory.length} reps flagged (pre-correction), ${pinHygiene.shared_pins} shared pins. ` +
      "Reports written to scripts/output/. NO database writes were made.",
  );
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
