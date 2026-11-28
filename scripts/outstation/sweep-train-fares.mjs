#!/usr/bin/env node
/**
 * Sweeps the Egyptian National Railways booking site (obs.enr.gov.eg) for every ordered pair of the
 * stations build-train-fares.mjs knows, on one travel day, and saves the JSON that script reads:
 *
 *   node scripts/outstation/sweep-train-fares.mjs <YYYY-MM-DD> <out.json>
 *
 * { date, rows: [[fromEn, fromAr, toEn, toAr, train, departs, arrives, minutes, km, ac2Piastres, ac1Piastres]] }
 * One row per DIRECT train (no change of train). The site's public endpoints need no sign-in:
 * GET /api/v1/serviceTripPoints/stations?type=0 and GET /api/v1/tickets/search. Class ids, read off the
 * site on 2026-11-28: 1210001 = AC 2 (ثانية مكيفة), 1210000 = AC 1 (أولى مكيفة). The site sends piastres.
 * Two searches at a time, so the sweep stays a polite reader (~1,500 searches, about 15 minutes).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

refuseUnknownFlags({ name: "sweep-train-fares", entry: import.meta.url, known: [] });

const [date, out] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !out) {
  throw new Error("usage: node scripts/outstation/sweep-train-fares.mjs <YYYY-MM-DD> <out.json>");
}

const SITE = "https://obs.enr.gov.eg/api/v1";
const AC2 = "1210001";
const AC1 = "1210000";

// The stations come from the builder itself, so the two scripts can never disagree on the list.
const builder = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "build-train-fares.mjs"), "utf8");
const block = builder.slice(builder.indexOf("const STATIONS = {"), builder.indexOf("};", builder.indexOf("const STATIONS = {")));
const wanted = [...block.matchAll(/(?:"([A-Z][A-Z .-]+)"|\b([A-Z][A-Z-]+)):\s*\[/g)].map((m) => m[1] ?? m[2]);

async function getJson(url, tries = 4) {
  for (let i = 1; ; i += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (i >= tries) throw new Error(`${url}: ${error instanceof Error ? error.message : error}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

const stations = await getJson(`${SITE}/serviceTripPoints/stations?type=0`);
const byName = new Map(stations.map((s) => [s.name, s]));
const missing = wanted.filter((n) => !byName.has(n));
if (missing.length) throw new Error(`stations the site does not list: ${missing.join(", ")}`);

const pairs = [];
for (const a of wanted) for (const b of wanted) if (a !== b) pairs.push([a, b]);

const rows = [];
let failed = 0;
let done = 0;
async function search([a, b]) {
  const from = byName.get(a);
  const to = byName.get(b);
  const q = new URLSearchParams({
    from: from.id, to: to.id, departureDate: date, skip_places_information: "true",
    with_reservations: "false", without_reservations: "false", transfers: "0",
  });
  try {
    const trips = await getJson(`${SITE}/tickets/search?${q}`);
    for (const t of trips) {
      if (t.steps?.length !== 1) continue;
      const s = t.steps[0];
      const costs = t.classesCostMap ?? {};
      rows.push([
        a, from.localizationMap?.ar ?? "", b, to.localizationMap?.ar ?? "",
        String(s.train?.name ?? ""), String(s.fromDate ?? "").slice(11, 16), String(s.finishDate ?? "").slice(11, 16),
        s.duration ?? null, t.distance ?? null, costs[AC2] ?? null, costs[AC1] ?? null,
      ]);
    }
  } catch (error) {
    failed += 1;
    console.error(String(error));
  }
  done += 1;
  if (done % 100 === 0) console.log(`${done}/${pairs.length} searched, ${rows.length} trains, ${failed} failed`);
}

const queue = [...pairs];
await Promise.all([0, 1].map(async () => { while (queue.length) await search(queue.shift()); }));
writeFileSync(out, JSON.stringify({ date, rows }));
console.log(`pairs ${pairs.length}, failed ${failed}, direct trains ${rows.length} -> ${out}`);
if (failed) process.exitCode = 1;
