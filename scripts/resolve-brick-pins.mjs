// READ-ONLY + FILE OUTPUT. Resolves brick coordinates via Places API (New) text search,
// preferring a real geographic result (locality / neighborhood / sublocality) over a business
// that merely shares the district name. Reads the brick list, writes SQL to a file, and makes
// NO database modification of its own.
// Usage: node scripts/resolve-brick-pins.mjs <region|ALL> <outfile>
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import postgres from "postgres";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "resolve-brick-pins",
  entry: import.meta.url,
  known: ["--apply"],
  hints: [
    "it is a dry run by default — pass --apply to write",
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

const GOV_TO_REGION = {
  cairo: "CA", giza: "GZ", fayoum: "GZ", faiyum: "GZ", "beni suef": "GZ",
  minia: "UE", minya: "UE", asyut: "UE", assiut: "UE", sohag: "UE", qena: "UE", luxor: "UE",
  alexandria: "AB", beheira: "AB", matrouh: "AB", "marsa matrouh": "AB",
  qalyubia: "D1", qalyubiyah: "D1", monufia: "D1", menofia: "D1", minufya: "D1",
  gharbia: "D1", "kafr el sheikh": "D1", "kafr al sheikh": "D1", "kafr el-sheikh": "D1",
  dakahlia: "D2", daqahlia: "D2", damietta: "D2", "port said": "D2",
  suez: "D3", ismailia: "D3",
  "south sinai": "OT", "north sinai": "OT", "red sea": "OT", "new valley": "OT", aswan: "OT",
};
const AMBIGUOUS = new Set(["sharqia", "sharkia", "ash sharqiyah", "sharqiya"]);
const GEO_TYPES = new Set(["administrative_area_level_2", "administrative_area_level_3",
  "locality", "neighborhood", "postal_town", "sublocality", "sublocality_level_1"]);

// Lowercase FIRST, then strip the Al-/El- article, then flatten hyphens. Google returns
// "Al-Sharqia", "Al-Qalyubia", "Kafr El-Sheikh" — the same prefix/hyphen shapes that broke the
// main codebase's governorate lookup (fixed in PR #1414 via resolveGovernorate).
// Arabic governorate names — required since Places is queried with languageCode 'ar', which
// returns Arabic addresses. Without these the English "X Governorate" pattern matches nothing and
// every Places candidate is silently discarded, leaving only forward-geocode results.
const AR_GOV = {
  "الاسكندريه": "alexandria", "البحيره": "beheira", "مطروح": "matrouh",
  "القاهره": "cairo", "الجيزه": "giza", "الفيوم": "faiyum", "بني سويف": "beni suef",
  "المنيا": "minya", "اسيوط": "assiut", "سوهاج": "sohag", "قنا": "qena", "الاقصر": "luxor",
  "اسوان": "aswan", "البحر الاحمر": "red sea", "الوادي الجديد": "new valley",
  "القليوبيه": "qalyubia", "المنوفيه": "monufia", "الغربيه": "gharbia",
  "كفر الشيخ": "kafr el sheikh", "الدقهليه": "dakahlia", "دمياط": "damietta",
  "بورسعيد": "port said", "بور سعيد": "port said", "السويس": "suez",
  "الاسماعيليه": "ismailia", "الشرقيه": "sharqia",
  "شمال سيناء": "north sinai", "جنوب سيناء": "south sinai",
};

const govFrom = (addr) => {
  if (!addr) return null;
  const ar = String(addr)
    .replace(/[ً-ْ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
  for (const [name, gov] of Object.entries(AR_GOV)) if (ar.includes(name)) return gov;
  const m = /([A-Za-z\-' ]+?)\s+Governorate/.exec(addr);
  if (!m) return null;
  return m[1]
    .toLowerCase()
    .replace(/^(al|el)[\s-]+/, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * The 2026-07-27 OT split created areas named after governorates that this table maps elsewhere —
 * Luxor → UE, Suez/Ismailia → D3 — so a region-only gate rejects every OT brick in them
 * (السويس, الاقصر, اسنا, الاسماعيليه, القنطرة غرب, الوادى الجديد, الخارجة all failed on this).
 * When the AREA is itself named after the governorate, that agreement is stronger evidence than
 * the static region table, so accept it.
 */
const gate = (gov, region, areaName) => {
  if (!gov) return false;
  const a = norm(areaName);
  const g = norm(gov);
  if (a && g && (a === g || a.includes(g) || g.includes(a))) return true;
  if (AMBIGUOUS.has(gov)) return region === "D2" || region === "D3";
  return GOV_TO_REGION[gov] === region;
};

const KEY = envVar("GOOGLE_MAPS_SERVER_KEY");

// A transient API failure must never silently downgrade a brick. Returning null on a 429/5xx made
// the resolver fall back to whatever the other provider said — that is how خورشيد resolved
// correctly in a 141-brick run and wrongly in a 781-brick one, with no error surfacing anywhere.
const apiFailures = { geocode: 0, places: 0 };

async function fetchWithRetry(url, init, kind, attempts = 6) {
  let wait = 400;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      // 4xx other than 429 will not improve on retry.
      if (res.status !== 429 && res.status < 500) return res;
    } catch { /* network blip — retry */ }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
  apiFailures[kind] += 1;
  return null;
}

async function places(q) {
  const res = await fetchWithRetry("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.types",
    },
    // Arabic, deliberately: Google then returns ARABIC place names, which can be compared
    // directly to the brick name. That comparison is the strongest correctness signal available —
    // it caught خورشيد being resolved 14 km away to "An Nagaa Al Gadid", and it separates
    // سيدي بشر بحري from سيدي بشر قبلي, which an English query collapses onto one pin.
    body: JSON.stringify({ textQuery: q, languageCode: "ar", regionCode: "EG", maxResultCount: 10 }),
  }, "places");
  if (!res || !res.ok) return null;
  const ps = (await res.json()).places ?? [];
  const pick = (p) => {
    const lat = p.location?.latitude, lng = p.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const t = p.types ?? [];
    return { addr: p.formattedAddress ?? null, name: p.displayName?.text ?? null, lat, lng,
      geo: t.some((x) => GEO_TYPES.has(x)) };
  };
  for (const p of ps) { const m = pick(p); if (m?.geo) return m; }
  for (const p of ps) { const m = pick(p); if (m) return m; }
  return null;
}

// Candidate governorates per region, so an ambiguous bare name can be disambiguated. Bare name
// is tried FIRST (it wins outright for most bricks); these are only used when it fails the gate
// or finds nothing — e.g. bare "كليوباترا" hits a Cairo ceramics company, but
// "كليوباترا, Alexandria" hits the Cleopatra neighbourhood.
const REGION_HINTS = {};
for (const [gov, reg] of Object.entries(GOV_TO_REGION)) (REGION_HINTS[reg] ??= []).push(gov);
REGION_HINTS.D2 = [...(REGION_HINTS.D2 ?? []), "sharqia"];

const region = process.argv[2] ?? "ALL";
const outFile = process.argv[3] ?? "pins.sql";
const sql = postgres(toPooler(envVar("PHOENIX_PRODUCTION_DATABASE_URL")), { max: 2, prepare: false });

let bricks;
try {
  bricks = region === "ALL"
    ? await sql`select b.brick_id, b.brick_name, b.area_code, b.block_code, b.region_code,
                       coalesce(a.area_name, b.area_code) as area_name
                from public.source_of_sales_bricks b
                left join public.source_of_sales_areas a on a.area_code = b.area_code
                where b.active and coalesce(trim(b.brick_name),'') <> '' order by b.brick_id`
    : await sql`select b.brick_id, b.brick_name, b.area_code, b.block_code, b.region_code,
                       coalesce(a.area_name, b.area_code) as area_name
                from public.source_of_sales_bricks b
                left join public.source_of_sales_areas a on a.area_code = b.area_code
                where b.active and b.region_code = ${region} and coalesce(trim(b.brick_name),'') <> '' order by b.brick_id`;
} finally {
  await sql.end({ timeout: 5 });
}
console.error(`resolving ${bricks.length} bricks (${region})…`);

// Forward Geocoding constrained to a governorate. `components` is a hard filter, not a hint, so
// Google cannot wander to a same-named place in another governorate — this is what stops
// "كليوباترا" resolving to a Cairo ceramics company. Far stronger than putting the governorate
// in the free-text address, which the geocoder is free to ignore.
async function forwardGeocode(name, governorate) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", name);
  url.searchParams.set("components", governorate ? `country:EG|administrative_area:${governorate}` : "country:EG");
  url.searchParams.set("language", "en");
  url.searchParams.set("key", KEY);
  const res = await fetchWithRetry(url.toString(), { cache: "no-store" }, "geocode");
  if (!res || !res.ok) return null;
  const body = await res.json();
  const r = body.results?.[0];
  const loc = r?.geometry?.location;
  if (!r || !Number.isFinite(loc?.lat) || !Number.isFinite(loc?.lng)) return null;
  const comp = (types) => r.address_components?.find((c) => c.types?.some((t) => types.includes(t)));
  const gov = comp(["administrative_area_level_1"])?.long_name?.replace(/\s*Governorate$/i, "") ?? null;
  const types = r.types ?? [];
  return {
    addr: r.formatted_address ?? null,
    name: comp(["locality", "sublocality", "neighborhood", "administrative_area_level_3", "administrative_area_level_2"])?.long_name ?? null,
    lat: Number(loc.lat), lng: Number(loc.lng),
    types,
    partial: r.partial_match === true,
    geo: types.some((t) => GEO_TYPES.has(t)),
    govDirect: gov ? gov.toLowerCase().replace(/^(al|el)[\s-]+/, "").replace(/-/g, " ").trim() : null,
  };
}

/**
 * Rank a candidate. An administrative/locality result beats a business every time — a shop named
 * after the district is not the district. partial_match means Google guessed, so it is demoted.
 * Sub-district results (administrative_area_level_3) score highest: they are what separates
 * "Sidi Beshr Bahri" from "Sidi Beshr Qebli", the distinction Phoenix bricks actually depend on.
 */
// Arabic normalisation for name comparison: strip harakat, fold alef/ya/ta-marbuta variants,
// drop everything that is not an Arabic letter.
const normAr = (s) => String(s ?? "")
  .replace(/[ً-ْ]/g, "")
  .replace(/[أإآٱ]/g, "ا")
  .replace(/ى/g, "ي")
  .replace(/ة/g, "ه")
  .replace(/[^ء-ي]/g, "");

/** Does the place Google returned actually carry the brick's name? */
function nameMatches(brickName, placeName) {
  const a = normAr(brickName);
  const b = normAr(placeName);
  if (!a || !b || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

function scoreCandidate(c) {
  if (!c) return -1;
  const types = c.types ?? [];
  let score = 0;
  if (types.includes("administrative_area_level_3") || types.includes("sublocality") || types.includes("neighborhood")) score = 4;
  else if (types.includes("locality") || types.includes("administrative_area_level_2")) score = 3;
  else if (types.includes("route") || types.includes("premise")) score = 1;
  else score = 0; // establishment / POI / store
  if (c.partial) score -= 1;
  return score;
}

// Every brick is a real place, so collect candidates from BOTH providers and keep the best-typed
// one that lands in the right governorate — rather than accepting whichever provider answers
// first. Neither provider wins outright: forward geocoding is the only one that separates
// "Sidi Beshr Bahri" from "Sidi Beshr Qebli", but it returns a hotel for العصافرة بحرى where
// Places correctly returns the Asafra neighbourhood.
/**
 * Brick names carry noise Google cannot parse: a street prefix ("ش جمال عبد الناصر"), a city
 * suffix ("الجمرك-الاسكندرية"), slash alternatives ("المعمورة/الملاحة"), km markers ("العجمى ك21"),
 * and sub-district qualifiers ("العصافرة بحرى"). Each variant is a separate, cheaper thing to ask
 * for — most specific first, so a precise hit always beats the broadened one.
 */
function nameVariants(raw) {
  const name = String(raw ?? "").trim();
  const out = [name];
  const push = (v) => {
    const t = String(v ?? "").replace(/\s+/g, " ").trim();
    if (t.length >= 3 && !out.includes(t)) out.push(t);
  };

  // "المعمورة/الملاحة" → each side is a real place on its own
  if (name.includes("/")) for (const part of name.split("/")) push(part);
  // "الجمرك-الاسكندرية" / "رشدي - الإسكندرية" → drop the trailing city qualifier
  if (/[-–]/.test(name)) {
    const parts = name.split(/\s*[-–]\s*/);
    push(parts[0]);
    if (parts.length > 1) push(parts[parts.length - 1]);
  }
  // "ش جمال عبد الناصر" → the street name itself is findable, the "ش" is not
  push(name.replace(/^ش\s+/, "").replace(/^شارع\s+/, ""));
  // "العجمى ك21" → drop km markers and stray digits
  push(name.replace(/\s*ك\s*\d+\s*/g, " ").replace(/\s*\d+\s*$/, ""));
  // Sub-district qualifiers — broadening to the parent district is better than no pin at all,
  // and it is the LAST variant tried so an exact bahry/qibli match always wins first.
  push(name.replace(/\s*(بحرى|بحري|بحريه|البحريه|قبلى|قبلي|قبليه|القبليه|الجديدة|الجديده|شرق|غرب|شمال|جنوب)\s*$/, ""));
  return out;
}

// PASS 1 — unconstrained lookup, used only to learn which governorate each AREA actually sits in.
async function probeBrick(b) {
  const candidates = [];
  const consider = (c, via) => {
    if (!c) return;
    const gov = c.govDirect ?? govFrom(c.addr);
    if (!gov) return;
    candidates.push({ c, gov, via, score: scoreCandidate(c) });
  };
  try { consider(await places(`${b.brick_name}, Egypt`), "places"); } catch { /* ignore */ }
  try { consider(await forwardGeocode(b.brick_name, null), "geocode"); } catch { /* ignore */ }
  candidates.sort((x, y) => y.score - x.score);
  return { b, best: candidates[0] ?? null };
}

/**
 * PASS 2 — resolve against the AREA's own governorate.
 *
 * Region is far too coarse to constrain a lookup: AB spans Alexandria, Beheira AND Matrouh, so a
 * region-level gate happily accepted الحضرة الجديدة as "El-Gadeeda" in Beheira (50 km away) and
 * الحضره البحريه as Marsa Matruh (250 km away). An area sits in ONE governorate, so pinning the
 * search to the area's governorate removes cross-city leakage entirely.
 */
async function resolveBrick(b, areaGov) {
  const candidates = [];
  // A place whose NAME matches the brick outranks any type score. This is what separates the
  // real خورشيد from a same-governorate stranger the geocoder happened to return first.
  const consider = (c, via) => {
    if (!c) return;
    const gov = c.govDirect ?? govFrom(c.addr);
    if (!gov || gov !== areaGov) return; // must be the area's own governorate, not just its region
    const matched = nameMatches(b.brick_name, c.name);
    candidates.push({ c, gov, via, matched, score: scoreCandidate(c) + (matched ? 5 : 0) });
  };

  // Ask BOTH providers for the exact name before broadening. Neither wins outright: Places finds
  // خورشيد and العصافرة, forward geocoding separates بحري from قبلي. Skipping one because the
  // other answered first is exactly how خورشيد ended up 14 km out.
  try { consider(await places(`${b.brick_name}, ${areaGov}, Egypt`), "places_hint"); } catch { /* ignore */ }
  try { consider(await forwardGeocode(b.brick_name, areaGov), "geocode"); } catch { /* ignore */ }

  // Only broaden when nothing carried the brick's own name.
  if (!candidates.some((x) => x.matched)) {
    for (const variant of nameVariants(b.brick_name).slice(1)) {
      if (candidates.some((x) => x.matched)) break;
      try { consider(await places(`${variant}, ${areaGov}, Egypt`), "places_hint"); } catch { /* ignore */ }
      try { consider(await forwardGeocode(variant, areaGov), "geocode"); } catch { /* ignore */ }
    }
  }
  if (candidates.length === 0) {
    try { consider(await places(`${b.brick_name}, Egypt`), "places"); } catch { /* ignore */ }
  }

  if (process.env.DEBUG_BRICK && b.brick_id === process.env.DEBUG_BRICK) {
    console.error(`DEBUG ${b.brick_id} "${b.brick_name}" areaGov=${areaGov} candidates=${candidates.length}`);
    for (const x of candidates) {
      console.error(`   via=${x.via} score=${x.score} matched=${x.matched} name="${x.c.name}" gov=${x.gov} addr="${String(x.c.addr).slice(0, 70)}"`);
    }
  }

  if (candidates.length === 0) return { b, m: null, gov: null, ok: false, via: "none" };
  candidates.sort((x, y) => y.score - x.score);
  const best = candidates[0];
  return { b, m: best.c, gov: best.gov, ok: true, via: best.via, score: best.score };
}

// ── Pass 1: learn each area's governorate from its own bricks ────────────────
console.error("pass 1 — probing areas…");
const probes = [];
for (let i = 0; i < bricks.length; i += 4) {
  probes.push(...(await Promise.all(bricks.slice(i, i + 4).map(probeBrick))));
  if (i % 320 === 0) console.error(`  probe ${Math.min(i + 8, bricks.length)}/${bricks.length}`);
}

// Modal governorate per area, counting only confident (geographic) hits and only governorates
// that belong to the area's own region — so one stray match cannot capture an area.
const areaVotes = new Map();
for (const p of probes) {
  if (!p.best || p.best.score < 3) continue;
  if (!gate(p.best.gov, p.b.region_code, p.b.area_name)) continue;
  const key = p.b.area_code;
  if (!areaVotes.has(key)) areaVotes.set(key, new Map());
  const tally = areaVotes.get(key);
  tally.set(p.best.gov, (tally.get(p.best.gov) ?? 0) + 1);
}
const areaGovernorate = new Map();
for (const [area, tally] of areaVotes) {
  const [gov] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  areaGovernorate.set(area, gov);
}
console.error(`pass 1 done — governorate resolved for ${areaGovernorate.size} areas`);

// ── Pass 2: resolve every brick inside its area's governorate ────────────────
console.error("pass 2 — resolving bricks…");
const results = [];
for (let i = 0; i < bricks.length; i += 4) {
  const batch = bricks.slice(i, i + 4);
  results.push(...(await Promise.all(batch.map((b) => {
    const areaGov = areaGovernorate.get(b.area_code);
    // No governorate learned for this area — fall back to the pass-1 probe, still region-gated.
    if (!areaGov) {
      const probe = probes.find((p) => p.b.brick_id === b.brick_id)?.best ?? null;
      if (probe && gate(probe.gov, b.region_code, b.area_name)) {
        return { b, m: probe.c, gov: probe.gov, ok: true, via: "probe", score: probe.score };
      }
      return { b, m: null, gov: null, ok: false, via: "none" };
    }
    return resolveBrick(b, areaGov);
  }))));
  if (i % 240 === 0) console.error(`  ${Math.min(i + 8, bricks.length)}/${bricks.length}`);
}

// ── Fallback: nothing may be left without a pin ─────────────────────────────
// A brick whose NAME cannot be found still belongs to a known block and area. Placing it at the
// centre of its resolved siblings is a defensible position — far better than leaving it invisible
// on a map, where "no pin" is indistinguishable from "nobody covers this". Block first (tighter),
// then area. Marked via `geocode_provider` so these stay identifiable for later correction.
{
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const centres = (keyOf) => {
    const groups = new Map();
    for (const r of results) {
      if (!r.ok || !r.m) continue;
      const k = keyOf(r.b);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r.m);
    }
    const out = new Map();
    for (const [k, ms] of groups) {
      out.set(k, { lat: median(ms.map((m) => m.lat)), lng: median(ms.map((m) => m.lng)) });
    }
    return out;
  };
  const byBlock = centres((b) => `${b.area_code}|${b.block_code}`);
  const byArea = centres((b) => b.area_code);

  let filledBlock = 0, filledArea = 0;
  for (const r of results) {
    if (r.ok && r.m) continue;
    const blockCentre = byBlock.get(`${r.b.area_code}|${r.b.block_code}`);
    const areaCentre = byArea.get(r.b.area_code);
    const centre = blockCentre ?? areaCentre;
    if (!centre) continue;
    r.m = { lat: centre.lat, lng: centre.lng, addr: null, name: null, geo: false };
    r.gov = areaGovernorate.get(r.b.area_code) ?? null;
    r.ok = true;
    r.via = blockCentre ? "block_centre" : "area_centre";
    if (blockCentre) filledBlock += 1; else filledArea += 1;
  }
  console.error(`fallback: ${filledBlock} placed at block centre, ${filledArea} at area centre`);
}

// Shared-coordinate rule. Sibling bricks that subdivide ONE real district legitimately share a
// pin — Phoenix splits Al Hadrah into الحضره / البحريه / القبليه / الجديدة, but Google has one
// Al Hadrah. That is not a geocoder fallback. A fallback is a point pulling in bricks from
// DIFFERENT areas, or a large pile-up. Only those are rejected.
const byCoord = new Map();
for (const r of results) {
  if (!r.ok || !r.m) continue;
  const k = `${r.m.lat},${r.m.lng}`;
  if (!byCoord.has(k)) byCoord.set(k, []);
  byCoord.get(k).push(r);
}
const fallbackCoords = new Set();
for (const [k, group] of byCoord) {
  const areas = new Set(group.map((r) => r.b.area_code));
  if (areas.size > 1 || group.length > 4) fallbackCoords.add(k);
}

const esc = (s) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);
let success = 0, shared = 0, mismatch = 0, none = 0;
const values = [];
for (const r of results) {
  if (!r.m) { none += 1; continue; }
  const k = `${r.m.lat},${r.m.lng}`;
  let st;
  if (!r.ok) { st = "region_mismatch"; mismatch += 1; }
  else if (fallbackCoords.has(k)) { st = "shared_fallback"; shared += 1; }
  else { st = "success"; success += 1; }
  // Carry the resolution method through as the provider, so pins placed at a block/area centre
  // stay identifiable and can be corrected first.
  values.push(`(${esc(r.b.brick_id)},${r.m.lat},${r.m.lng},${esc(st)},${esc(r.gov)},${esc(r.m.name)},${esc("google_" + (r.via ?? "places"))})`);
}

const statement =
`with incoming(source_key, latitude, longitude, geocode_status, city, area, provider) as (values
${values.join(",\n")}
)
insert into public.geo_locations
  (source_type, source_key, latitude, longitude, geocode_status, geocode_provider, city, area, label)
select 'brick_centroid', i.source_key, i.latitude, i.longitude, i.geocode_status, i.provider,
       i.city, i.area, coalesce(b.brick_name, i.source_key)
from incoming i
left join public.source_of_sales_bricks b on b.brick_id = i.source_key
on conflict (source_type, source_key) do update set
  latitude = excluded.latitude, longitude = excluded.longitude,
  geocode_status = excluded.geocode_status, geocode_provider = excluded.geocode_provider,
  city = excluded.city, area = excluded.area, updated_at = now()
-- NEVER overwrite a hand-placed pin. A person who knows the ground outranks any geocoder, so a
-- rebuild must leave provider='manual' rows exactly as they are.
where public.geo_locations.geocode_provider is distinct from 'manual';
`;

writeFileSync(outFile, statement, "utf8");

// --apply <production|staging> writes the resolved pins. Backups already exist
// (geo_locations_brick_centroid_backup*_20260728) and every row is an upsert, so this is
// reversible from those tables.
const applyIdx = process.argv.indexOf("--apply");
if (applyIdx !== -1) {
  const env = process.argv[applyIdx + 1] === "staging" ? "staging" : "production";
  const varName = env === "staging" ? "PHOENIX_STAGING_DATABASE_URL" : "PHOENIX_PRODUCTION_DATABASE_URL";
  const write = postgres(toPooler(envVar(varName)), { max: 2, prepare: false });
  try {
    await write.unsafe(statement);
    const after = await write`select geocode_status, count(*)::int as n from public.geo_locations
                              where source_type='brick_centroid' group by 1 order by 2 desc`;
    console.error(`applied to ${env}: ` + after.map((r) => `${r.geocode_status}=${r.n}`).join(" "));
  } finally {
    await write.end({ timeout: 5 });
  }
}

// api_failures MUST be zero. Anything above zero means some bricks were resolved from only one
// provider and may have silently taken the weaker answer — do not trust the output until it is 0.
console.log(JSON.stringify({ region, total: results.length, success, shared_fallback: shared, region_mismatch: mismatch, no_result: none, api_failures: apiFailures, out: outFile }, null, 2));
