import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  SOS_DASHBOARD_CACHE_MAX_BYTES,
  packSosRows,
  unpackSosRows,
  type SosRpcRows,
} from "../src/lib/sales/sos-dashboard.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-004 (2026-10-04) — the Source of Sales dashboard's data cache holds PACKED rows, and every
 * viewer goes through it.
 *
 * (a) The cache used to hold the raw RPC rows, and they outgrew Next's 2 MB data-cache entry: a CNS
 *     cross-line view for 2026-08 measured 2.08 MB, which production silently refuses to store (a
 *     console.warn and no cache at all) and dev turns into an unhandled rejection that kills the
 *     server. The rows are now gzip + base64 packed exactly as vs-target.ts packs achievement rows,
 *     and a pack that would not fit — or that carries a FAILED aggregate — is never cached.
 * (b) OWNER DECISION, 2026-10-04: the CEO / Super Admin company-wide view uses the same 5-minute
 *     cache as everyone else. It used to bypass the cache precisely because the raw rows were too big.
 *
 * The cache key is still the fully scope-resolved inputs, confidential exclude codes included, so
 * two viewers share an entry only when they are entitled to identical rows.
 */

const DASHBOARD = "src/lib/sales/sos-dashboard.ts";

function rows(overrides: Partial<SosRpcRows> = {}): SosRpcRows {
  return {
    detailRows: [
      { distributor_code: "UPA", region_code: "RG1", area_code: "D14", product_code: "LA001", sales_value: 1250.5, sales_units: 12, __period: "2026-08" },
      { distributor_code: "QM", region_code: null, area_code: "", product_code: "CN002", sales_value: -40, sales_units: -1, __period: "2026-08" },
    ],
    trendRowsRaw: [{ period: "2026-07", line: "Pedia", value: 99.99 }],
    brickRaw: [{ brick_id: "B215-2", brick_name: "كوم حماده", sales_value: 10 }],
    customerRaw: [{ client_code: "1011654", client_name: "مخزن شركة اى زد", distributor_code: "EZ", sales_value: 0 }],
    priorDetailRaw: [],
    yoyDetailRaw: [{ product_code: "LA001", sales_value: 1, __period: "2025-08" }],
    failedRpcs: [],
    ...overrides,
  };
}

function definitionOf(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} must exist in ${DASHBOARD}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `${start} must be followed by ${end}`);
  return source.slice(from, to);
}

export async function runSosDashboardPackedCacheTests() {
  // ── 1. Pack → unpack is the identity on the rows ─────────────────────────────────
  {
    const original = rows();
    const packed = await packSosRows(original);
    assert.equal(typeof packed, "string", "a complete, small read must pack");
    assert.match(packed!, /^[A-Za-z0-9+/=]+$/, "the packed entry is base64, so its length is the size Next measures");
    assert.deepEqual(
      await unpackSosRows(packed!),
      original,
      "unpacking must give back exactly the rows that were packed — Arabic names, nulls, negatives and the __period tag included",
    );
    const twice = await unpackSosRows(packed!);
    assert.notEqual(twice.detailRows, original.detailRows, "every reader gets its own copy of the rows");
  }

  // ── 2. A failed aggregate is never packed, so never cached ─────────────────────────
  {
    assert.equal(
      await packSosRows(rows({ failedRpcs: ["phx_exec_customers"] })),
      null,
      "a read carrying a failed RPC must not be cached — it would serve the same incomplete numbers for the whole TTL",
    );
  }

  // ── 3. An entry that would not fit even packed is never handed to the cache ────────
  {
    assert.ok(SOS_DASHBOARD_CACHE_MAX_BYTES < 2_000_000, "the ceiling must sit under Next's hard 2 MB entry limit");
    // Random bytes do not compress, so this is a payload that stays big after gzip.
    const incompressible = randomBytes(1_600_000).toString("base64");
    assert.equal(
      await packSosRows(rows({ customerRaw: [{ client_code: "X", blob: incompressible }] })),
      null,
      "a pack over the ceiling must come back null so the caller reads live instead of tripping Next's 2 MB refusal",
    );
  }

  // ── 4. Wiring: the cache only ever sees a packed value, and nobody bypasses it ─────
  {
    const source = stripComments(readFileSync(DASHBOARD, "utf8"));
    const calls = source.match(/unstable_cache\(/g) ?? [];
    assert.equal(calls.length, 1, "sos-dashboard.ts must have exactly one unstable_cache — the packed one");
    assert.match(
      source,
      /unstable_cache\(\s*async \(inputs: SosRpcInputs\) => packSosRows\(await fetchSosDashboardRpcRowsUncached\(inputs\)\),\s*\["sos-dashboard-packed"\],\s*\{ revalidate: 300, tags: \["sos-dashboard"\] \},?\s*\)/,
      "unstable_cache must be handed packSosRows(...) — never the raw SosRpcRows — under the same 300s and the same sos-dashboard tag",
    );
    assert.ok(
      !/unstable_cache\(\s*fetchSosDashboardRpcRowsUncached/.test(source),
      "the raw row fetcher must never be cached directly again",
    );

    const reader = definitionOf(source, "async function fetchSosDashboardRpcRows(", "\n}\n");
    assert.ok(
      !/canSeeCrossLineGeography/.test(reader),
      "no viewer may skip the cache on canSeeCrossLineGeography — the CEO / Super Admin view is cached too (owner, 2026-10-04)",
    );
    assert.ok(
      !/trendLineNames/.test(reader),
      "the company-wide (no line restriction) view must not be routed around the cache",
    );
    assert.match(
      reader,
      /const packed = await fetchSosDashboardRpcRowsPacked\(inputs\);[\s\S]*if \(packed !== null\)[\s\S]*unpackSosRows\(packed\)[\s\S]*return fetchSosDashboardRpcRowsUncached\(inputs\);/,
      "the reader unpacks a cached entry and reads live only when the cache holds none",
    );
  }
}
