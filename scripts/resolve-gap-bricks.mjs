// READ-ONLY + FILE OUTPUT. Second-pass resolver for the bricks the main rebuild could not place
// precisely: those left on a shared town centre, those whose matched name disagrees with the brick
// name, and any active brick with no pin at all.
//
// It differs from resolve-brick-pins.mjs in the gate it uses. That script had to fall back to a
// region-wide governorate test, which is far too coarse (AB alone spans Alexandria, Beheira and
// Matrouh). By now most bricks in each area are resolved AND confirmed by Arabic name match, so
// this pass gates candidates against the area's OWN confirmed siblings instead. A brick belongs
// near the bricks it shares an area with; that is a much tighter and more honest test.
//
// Usage: node scripts/resolve-gap-bricks.mjs <outfile>
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import postgres from "postgres";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "resolve-gap-bricks",
  entry: import.meta.url,
  known: [],
  hints: [
    "its one argument is the output file: node scripts/resolve-gap-bricks.mjs [gap-pins.sql]",
  ],
});

const ENV_FILES = [".env.staging.rls.local", ".env.production.rls.local", ".env.local"];

function envVar(name) {
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  throw new Error("missing " + name);
}

function toPooler(raw) {
  const m = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  if (!m) return raw;
  const [, scheme, user, pass, ref, , db] = m;
  return `${scheme}://${user}.${ref}:${pass}@aws-0-eu-central-1.pooler.supabase.com:5432/${db}`;
}

const KEY = envVar("LOCATIONIQ_API_KEY");

// LocationIQ is OpenStreetMap-backed, so a result carries an explicit class/type rather than
// Google's blended "types" list. That is a cleaner district-vs-business signal: a real district is
// place=village/suburb/town, whereas a shop that borrowed the district name is shop=* or amenity=*
// and is rejected outright instead of having to be filtered out afterwards.
const GEO_CLASSES = new Set(["place", "boundary"]);
const GEO_TYPES = new Set([
  "city", "town", "village", "hamlet", "suburb", "neighbourhood", "quarter",
  "municipality", "administrative", "city_district", "borough", "isolated_dwelling",
]);

const apiFailures = { locationiq: 0 };

// Global request gate. A per-brick pause is not enough: several lookups fire per brick, so the
// real request rate was ~3/s against a ~60/min tier and 16 lookups were dropped after exhausting
// their retries. Serialising every request behind one chain is the only way to hold the true rate.
const MIN_REQUEST_GAP_MS = 1150;
let gate = Promise.resolve();
function rateLimit() {
  const wait = gate.then(() => new Promise((r) => setTimeout(r, MIN_REQUEST_GAP_MS)));
  gate = wait;
  return wait;
}

async function fetchWithRetry(url, init, kind, attempts = 6) {
  await rateLimit();
  let wait = 400;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) return res;
    } catch {
      // network blip - fall through to the backoff below
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
  apiFailures[kind] += 1;
  return null;
}

// Arabic letter-shape normalisation, so أبو قير and ابوقير compare equal.
const norm = (s) =>
  (s ?? "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[ئ]/g, "ي").replace(/[ؤ]/g, "و").replace(/[^ء-ي]/g, "");

// Substring containment is NOT good enough here, and the failure is not theoretical: it accepted
// "El Hamam Spa", "فندق سفير القاهرة" (a hotel), "مدرسة سيدي طلحة" (a school) and
// "مكتب بريد حدائق شبرا" (a post office) as confirmations, because a business named after its
// district contains the district name. Require the names to be essentially the same string, and
// separately require Google to classify the result as a place rather than an establishment.
const MAX_EXTRA_CHARS = 3;
function nameMatches(brick, candidate) {
  const a = norm(brick), b = norm(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.includes(short) && long.length - short.length <= MAX_EXTRA_CHARS;
}

const R = 6371;
function km(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  const v = Math.sin(aLat * rad) * Math.sin(bLat * rad) +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.cos((bLng - aLng) * rad);
  return R * Math.acos(Math.min(1, Math.max(-1, v)));
}

async function lookup(q) {
  const url = new URL("https://us1.locationiq.com/v1/search");
  url.searchParams.set("key", KEY);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "10");
  url.searchParams.set("countrycodes", "eg");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  // Arabic names back, so the returned name can be compared directly with the brick name.
  url.searchParams.set("accept-language", "ar");
  const res = await fetchWithRetry(url.toString(), {}, "locationiq");
  if (!res || !res.ok) return [];
  const j = await res.json();
  if (!Array.isArray(j)) return []; // LocationIQ returns {error:"Unable to geocode"} on a miss
  return j.map((r) => ({
    // namedetails carries the local-language name; display_name is a full postal string.
    name: r.namedetails?.["name:ar"] ?? r.namedetails?.name ?? String(r.display_name ?? "").split(",")[0],
    lat: Number(r.lat), lng: Number(r.lon),
    geo: GEO_CLASSES.has(r.class) && GEO_TYPES.has(r.type),
    via: "locationiq",
  })).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
}

const outFile = process.argv[2] ?? "gap-pins.sql";
const sql = postgres(toPooler(envVar("PHOENIX_PRODUCTION_DATABASE_URL")), { max: 2, prepare: false });

let targets, centres;
try {
  // Area centres + governorate, built ONLY from pins confirmed by Arabic name match. An
  // unconfirmed pin must never help decide where another brick goes.
  centres = await sql`
    with n as (
      select b.area_code, g.latitude lat, g.longitude lng, g.city,
             regexp_replace(translate(b.brick_name,'أإآىةئؤ','ااايهيو'),'[^ء-ي]','','g') bn,
             regexp_replace(translate(coalesce(g.area,''),'أإآىةئؤ','ااايهيو'),'[^ء-ي]','','g') an
      from public.source_of_sales_bricks b
      join public.geo_locations g on g.source_type='brick_centroid' and g.source_key=b.brick_id
      where coalesce(b.active,true) and g.geocode_status='success'
    )
    select area_code, avg(lat)::float8 clat, avg(lng)::float8 clng, count(*)::int n,
           mode() within group (order by city) gov
    from n where an<>'' and (an like '%'||bn||'%' or bn like '%'||an||'%')
    group by area_code`;

  targets = await sql`
    with n as (
      select b.brick_id, b.brick_name, b.area_code, b.block_code, b.region_code,
             g.latitude lat, g.longitude lng, g.geocode_status st, g.geocode_provider pv,
             coalesce(g.area,'') matched_name,
             regexp_replace(translate(b.brick_name,'أإآىةئؤ','ااايهيو'),'[^ء-ي]','','g') bn,
             regexp_replace(translate(coalesce(g.area,''),'أإآىةئؤ','ااايهيو'),'[^ء-ي]','','g') an
      from public.source_of_sales_bricks b
      left join public.geo_locations g on g.source_type='brick_centroid' and g.source_key=b.brick_id
      where coalesce(b.active,true) and b.region_code <> 'OT'
    )
    select brick_id, brick_name, area_code, block_code, lat, lng, st
    from n
    where coalesce(pv,'') <> 'manual'
      and (st is null or st='shared_fallback'
           or (st='success' and an<>'' and not (an like '%'||bn||'%' or bn like '%'||an||'%'))
           -- pins that landed on a business which merely borrowed the district's name
           or matched_name ~ '(فندق|مطعم|مدرسة|مكتب بريد|صيدلية|شركة|مكتبة|سوبرماركت|ماركت|كافيه|مستشفى|بنك|نادي|محطة|مسجد|كنيسة|مول|معرض|قاعة|منتجع|سبا|Spa|Hotel|Restaurant|Market|Pharmacy|School|Cafe|Supeco)')
    order by brick_id`;
} finally {
  await sql.end({ timeout: 5 });
}

const centreOf = new Map(centres.map((c) => [c.area_code, c]));

const MAX_KM = 45;      // beyond this a candidate is not plausibly in the same area
const SAME_SPOT_KM = 0.15; // landing back on the shared centre is not an improvement

async function resolveOne(b) {
  const centre = centreOf.get(b.area_code);
  const gov = centre?.gov ?? null;
  const queries = [
    gov ? `${b.brick_name}، ${gov}` : null,
    gov ? `${b.brick_name}، ${gov}، مصر` : null,
    b.brick_name,
    b.block_code ? `${b.brick_name} ${b.block_code}` : null,
  ].filter(Boolean);

  const seen = [];
  for (const q of queries) {
    seen.push(...(await lookup(q)));
    // Stop only on a genuine geographic hit; a matching shop name must not end the search.
    if (seen.some((c) => c.geo && nameMatches(b.brick_name, c.name))) break;
  }
  if (seen.length === 0) return null;

  let best = null;
  for (const c of seen) {
    const d = centre ? km(c.lat, c.lng, centre.clat, centre.clng) : 0;
    if (centre && d > MAX_KM) continue;
    if (b.lat != null && km(c.lat, c.lng, Number(b.lat), Number(b.lng)) < SAME_SPOT_KM) continue;
    const score = (nameMatches(b.brick_name, c.name) ? 100 : 0) + (c.geo ? 10 : 0) - d / 10;
    if (!best || score > best.score) best = { ...c, d, score };
  }
  if (!best) return null;
  // Both tests must pass: the name is the same place, AND Google calls it a locality/neighbourhood/
  // administrative area rather than a shop, school or hotel that borrowed the district's name.
  return { ...best, matched: best.geo && nameMatches(b.brick_name, best.name) };
}

const results = [];
let done = 0;
const queue = [...targets];
async function worker() {
  for (;;) {
    const b = queue.shift();
    if (!b) return;
    const r = await resolveOne(b);
    done += 1;
    if (done % 20 === 0) console.log(`  ${done}/${targets.length}`);
    if (r) results.push({ b, r });
  }
}
// LocationIQ's free tier allows 2 requests/second. Two workers with a small pause each keeps us
// under that; going wider just earns 429s, and a silently-dropped lookup is how the last rebuild
// degraded without anyone noticing.
await Promise.all(Array.from({ length: 2 }, worker));

const esc = (s) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);
// Only pins whose returned Arabic name agrees with the brick name are written. A candidate that
// merely moved off the shared town centre is still a guess, and promoting it to 'success' would
// render it on the map as a confirmed location. An honest gap beats a confident wrong pin.
const confirmed = results.filter(({ r }) => r.matched);
const rows = confirmed.map(({ b, r }) =>
  `(${esc(b.brick_id)},${r.lat.toFixed(6)},${r.lng.toFixed(6)},${esc(r.via)},${esc(r.name)})`);

writeFileSync(outFile, rows.length === 0 ? "-- no improvements found\n" :
  `with incoming(source_key, latitude, longitude, provider, area) as (values\n${rows.join(",\n")}\n)
insert into public.geo_locations
  (source_type, source_key, latitude, longitude, geocode_status, geocode_provider, area, label)
select 'brick_centroid', i.source_key, i.latitude, i.longitude, 'success', i.provider,
       i.area, coalesce(b.brick_name, i.source_key)
from incoming i
left join public.source_of_sales_bricks b on b.brick_id = i.source_key
on conflict (source_type, source_key) do update set
  latitude = excluded.latitude, longitude = excluded.longitude,
  geocode_status = excluded.geocode_status, geocode_provider = excluded.geocode_provider,
  area = excluded.area, updated_at = now()
-- NEVER overwrite a hand-placed pin.
where public.geo_locations.geocode_provider is distinct from 'manual';\n`);

console.log(JSON.stringify({
  targets: targets.length,
  written_name_confirmed: confirmed.length,
  skipped_moved_but_unconfirmed: results.length - confirmed.length,
  skipped_no_candidate: targets.length - results.length,
  api_failures: apiFailures,
  out: outFile,
}, null, 2));
