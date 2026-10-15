// READ-ONLY report. Joins the resolved pins (pins.sql) against the brick master and prints, for
// every region and area, how many bricks got a location and how many did not.
// Usage: node scripts/pin-coverage-report.mjs <pins.sql> [--csv <out.csv>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import postgres from "postgres";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "pin-coverage-report",
  entry: import.meta.url,
  known: ["--csv"],
  hints: [
    "usage: node scripts/pin-coverage-report.mjs <pins.sql> [--csv <out.csv>]",
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

const pinsFile = process.argv[2];
const status = new Map();
for (const line of readFileSync(pinsFile, "utf8").split(/\r?\n/)) {
  const m = /^\('([^']+)',[-0-9.]+,[-0-9.]+,'([a-z_]+)'/.exec(line.trim());
  if (m) status.set(m[1], m[2]);
}

const sql = postgres(toPooler(envVar("PHOENIX_PRODUCTION_DATABASE_URL")), { max: 2, prepare: false });
let rows;
try {
  rows = await sql`
    select b.region_code, b.area_code, coalesce(a.area_name, b.area_code) as area_name, b.brick_id
    from public.source_of_sales_bricks b
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    where b.active and coalesce(trim(b.brick_name), '') <> ''
    order by b.region_code, b.area_code, b.brick_id`;
} finally {
  await sql.end({ timeout: 5 });
}

const areas = new Map();
for (const r of rows) {
  const key = `${r.region_code}|${r.area_code}|${r.area_name}`;
  if (!areas.has(key)) areas.set(key, { total: 0, located: 0, shared: 0, missing: 0 });
  const a = areas.get(key);
  a.total += 1;
  const st = status.get(r.brick_id);
  if (st === "success") a.located += 1;
  else if (st === "shared_fallback") a.shared += 1;
  else a.missing += 1;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(pad("REGION", 7) + pad("AREA", 7) + pad("AREA NAME", 30) + num("BRICKS", 7) + num("LOCATED", 9) + num("SHARED", 8) + num("NONE", 6) + num("  %", 7));
console.log("-".repeat(80));

let curRegion = null;
const totals = { total: 0, located: 0, shared: 0, missing: 0 };
const csv = ["region,area_code,area_name,bricks,located,shared_pin,no_location,pct_located"];
for (const [key, a] of [...areas.entries()].sort()) {
  const [region, area, name] = key.split("|");
  if (curRegion && curRegion !== region) console.log("");
  curRegion = region;
  const pct = ((a.located / a.total) * 100).toFixed(0) + "%";
  console.log(pad(region, 7) + pad(area, 7) + pad(name.slice(0, 29), 30) + num(a.total, 7) + num(a.located, 9) + num(a.shared, 8) + num(a.missing, 6) + num(pct, 7));
  csv.push([region, area, `"${name}"`, a.total, a.located, a.shared, a.missing, pct].join(","));
  totals.total += a.total; totals.located += a.located; totals.shared += a.shared; totals.missing += a.missing;
}
console.log("-".repeat(80));
console.log(pad("TOTAL", 44) + num(totals.total, 7) + num(totals.located, 9) + num(totals.shared, 8) + num(totals.missing, 6) +
  num(((totals.located / totals.total) * 100).toFixed(0) + "%", 7));

const csvIdx = process.argv.indexOf("--csv");
if (csvIdx !== -1 && process.argv[csvIdx + 1]) {
  writeFileSync(process.argv[csvIdx + 1], csv.join("\n"), "utf8");
  console.log(`\ncsv: ${process.argv[csvIdx + 1]}`);
}
