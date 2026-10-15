/**
 * Re-resolve ONE month's import rows against the ACTIVE customer -> brick map.
 *
 * Why this exists. The Source of Sales import resolves each file row to a brick (and so to an area
 * and a region) at UPLOAD time. When the owner later corrects a customer's mapping, the rows that
 * were already imported keep the brick they were given, so the month's sales sit in the wrong area
 * until something re-points them. The Mapping Database screen does exactly that, for ONE customer
 * per request (app/api/sales/mapping-database/customer-map/route.ts -> the
 * applyHistoricalReconciliation wrapper). September 2026 CNS had 1,212 customers in that state,
 * which is not a screen's job.
 *
 * What it does. It finds every (distributor, customer) pair whose rows in the chosen period and
 * line disagree with the active map, then calls the SAME repair the screen calls —
 * sos_reconcile_import_rows_from_customer_map — once per pair, and refreshes each affected file's
 * totals ONCE at the end instead of once per customer (refreshBatchRollups rebuilds the whole
 * rollup chain including the wholesaler split net, so running it per customer would take hours).
 *
 * A PUBLISHED MONTH IS REFUSED OUTRIGHT, BY ASKING THE PUBLICATION TABLE ITSELF. Two things stand
 * in the way of a published month, and only one of them used to be here. The RPC skips any file
 * that holds a row in a LOCKED closing (sos_import_batch_touches_locked_closing), whole file at a
 * time, so a July file is never half-corrected — but a lock is the owner's switch on
 * monthly_closing_locks and a publication is a row in monthly_closing_publications, set from two
 * different screens at two different times, and NOTHING pairs them. So this script also reads the
 * publications and refuses to apply when the period it was given is published, or when ANY row it
 * would rewrite sits in a published month (src/lib/sales/published-month-guard.ts — the owner's
 * rule of 2026-10-09, "never cange a publkished month"). A dry run reports instead of refusing,
 * because measuring a month is not changing it. It still prints the files a lock will skip before
 * it writes anything.
 *
 * THE REPAIR IS PER (DISTRIBUTOR, CUSTOMER) AND IGNORES THE PERIOD. A pair selected from the CNS
 * rows of one month also has its OTHER lines' and other months' rows re-pointed, wherever a lock
 * does not freeze them. That is the point — the map is the truth for every row of that customer —
 * but it means the dry run's list is wider than the line you asked about. Read it.
 *
 * It does NOT bust the dashboard caches: src/lib/dashboard/invalidation.ts imports next/cache, which
 * does not exist outside the Next runtime. Those caches carry a 300s TTL, so the Source of Sales
 * dashboard catches up within five minutes of the run on its own.
 *
 * Usage (from the repo root; it reads and writes the database .env.local points at, which is
 * PRODUCTION):
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/reconcile-month-customer-map.ts [--apply] [--period=2026-09] [--line=cns] \
 *     [--actor=B-10] [--preimage=<path.csv>]
 *
 * Without --apply it writes NOTHING to the database. Either way it writes the pre-image of every
 * row it would change to a CSV first, so the before state survives the run.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { writeAuditLog } from "@/lib/admin/audit";
import { refreshBatchRollups } from "@/lib/sales/normalizer/customer-map";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import {
  findPublishedMonthsAtRisk,
  livePublishedPeriods,
  publishedMonthGuardMessage,
  publishedMonthRiskIsClear,
  type PublishedMonthRisk,
} from "@/lib/sales/published-month-guard";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "reconcile-month-customer-map",
  entry: import.meta.url,
  known: ["--apply", "--period", "--line", "--actor", "--preimage"],
});

type ImportRow = {
  id: number;
  batch_id: string;
  distributor_code: string | null;
  client_code: string | null;
  client_name: string | null;
  invoice_period: string | null;
  official_line: string | null;
  brick_id: string | null;
  area_code: string | null;
  area_name: string | null;
  region_code: string | null;
  region_name: string | null;
  value: number | null;
};

type MapTarget = { brickId: string; areaCode: string | null; regionCode: string | null };
type PendingRow = ImportRow & { target: MapTarget };

const apply = process.argv.includes("--apply");

function flag(name: string, fallback: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const period = flag("period", "2026-09");
const line = flag("line", "cns").toLowerCase();
const actorLoginId = flag("actor", "B-10");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const preimagePath = flag("preimage", `xlsx/customer-map-reconcile-preimage-${period}-${stamp}.csv`);

const supabase = getSupabaseAdmin();

const normalizedLine = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();
const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Every read here can exceed PostgREST's 1000-row cap, so every read pages.
async function page<T>(
  read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const size = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await read(from, from + size - 1);
    if (error) throw new Error(`reading ${what}: ${error.message}`);
    const chunk = (data ?? []) as T[];
    rows.push(...chunk);
    if (chunk.length < size) break;
  }
  return rows;
}

async function periodBatchIds(): Promise<string[]> {
  const rows = await page<{ id: string }>(
    (from, to) =>
      supabase
        .from("source_of_sales_import_batches")
        .select("id")
        .eq("period", period)
        .eq("status", "validated")
        .order("id", { ascending: true })
        .range(from, to),
    "the period's validated files",
  );
  return rows.map((row) => row.id);
}

// The active map, as one lookup keyed "<distributor>|<customer>". Mirrors the RPC's own selection:
// active, brick_id not null, joined to the brick for its area and region.
async function activeMap(): Promise<Map<string, MapTarget>> {
  const bricks = await page<{ brick_id: string; area_code: string | null; region_code: string | null }>(
    (from, to) =>
      supabase
        .from("source_of_sales_bricks")
        .select("brick_id, area_code, region_code")
        .order("brick_id", { ascending: true })
        .range(from, to),
    "the brick master",
  );
  const brickById = new Map(bricks.map((brick) => [brick.brick_id, brick]));
  const rows = await page<{ distributor_code: string | null; customer_code: string | null; brick_id: string | null }>(
    (from, to) =>
      supabase
        .from("source_of_sales_customer_map")
        .select("distributor_code, customer_code, brick_id")
        .eq("active", true)
        .not("brick_id", "is", null)
        .order("distributor_code", { ascending: true })
        .order("customer_code", { ascending: true })
        .range(from, to),
    "the customer map",
  );
  const map = new Map<string, MapTarget>();
  for (const row of rows) {
    const brickId = String(row.brick_id ?? "").trim();
    const brick = brickById.get(brickId);
    if (!brick) continue;
    const key = `${normalizeCodeKey(String(row.distributor_code ?? ""))}|${String(row.customer_code ?? "").trim()}`;
    map.set(key, { brickId, areaCode: brick.area_code, regionCode: brick.region_code });
  }
  return map;
}

function rowKey(row: ImportRow): string {
  return `${normalizeCodeKey(String(row.distributor_code ?? ""))}|${String(row.client_code ?? "").trim()}`;
}

function disagrees(row: ImportRow, target: MapTarget): boolean {
  return (
    String(row.brick_id ?? "") !== target.brickId ||
    String(row.area_code ?? "") !== String(target.areaCode ?? "") ||
    String(row.region_code ?? "") !== String(target.regionCode ?? "")
  );
}

const ROW_COLUMNS =
  "id, batch_id, distributor_code, client_code, client_name, invoice_period, official_line, brick_id, area_code, area_name, region_code, region_name, value";

// The pairs to repair: rows of THIS period and line whose brick disagrees with the active map.
async function pairsToRepair(batchIds: string[], map: Map<string, MapTarget>): Promise<Map<string, MapTarget>> {
  const pairs = new Map<string, MapTarget>();
  for (const batchId of batchIds) {
    const rows = await page<ImportRow>(
      (from, to) =>
        supabase
          .from("source_of_sales_import_rows")
          .select(ROW_COLUMNS)
          .eq("batch_id", batchId)
          .order("id", { ascending: true })
          .range(from, to),
      `file ${batchId}'s rows`,
    );
    for (const row of rows) {
      if (normalizedLine(row.official_line) !== line) continue;
      const target = map.get(rowKey(row));
      if (!target) continue;
      if (disagrees(row, target)) pairs.set(rowKey(row), target);
    }
  }
  return pairs;
}

// Every row the RPC would rewrite, for the pre-image: ALL periods and ALL lines of those customers,
// minus the files a lock freezes. Read by customer code in chunks, then filtered back to the pairs.
async function rowsThatWillChange(
  pairs: Map<string, MapTarget>,
): Promise<{ rows: PendingRow[]; frozenBatches: Set<string> }> {
  const customerCodes = [...new Set([...pairs.keys()].map((key) => key.split("|")[1]))];
  const found: ImportRow[] = [];
  const chunk = 150;
  for (let index = 0; index < customerCodes.length; index += chunk) {
    const slice = customerCodes.slice(index, index + chunk);
    const rows = await page<ImportRow>(
      (from, to) =>
        supabase
          .from("source_of_sales_import_rows")
          .select(ROW_COLUMNS)
          .in("client_code", slice)
          .order("id", { ascending: true })
          .range(from, to),
      "the customers' rows across every period",
    );
    found.push(...rows);
  }
  const candidates: PendingRow[] = [];
  for (const row of found) {
    const target = pairs.get(rowKey(row));
    if (!target) continue;
    if (disagrees(row, target)) candidates.push({ ...row, target });
  }
  // The lock check is per FILE, so ask once per file rather than once per row.
  const frozenBatches = new Set<string>();
  for (const batchId of new Set(candidates.map((row) => row.batch_id))) {
    const { data, error } = await supabase.rpc("sos_import_batch_touches_locked_closing", { p_batch_id: batchId });
    if (error) throw new Error(`asking whether file ${batchId} is in a locked closing: ${error.message}`);
    if (data === true) frozenBatches.add(batchId);
  }
  return { rows: candidates.filter((row) => !frozenBatches.has(row.batch_id)), frozenBatches };
}

function csv(rows: PendingRow[]): string {
  const header = [
    "row_id",
    "batch_id",
    "distributor_code",
    "client_code",
    "client_name",
    "invoice_period",
    "official_line",
    "value",
    "brick_id_before",
    "area_code_before",
    "area_name_before",
    "region_code_before",
    "region_name_before",
    "brick_id_after",
    "area_code_after",
    "region_code_after",
  ];
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.batch_id,
        row.distributor_code,
        row.client_code,
        row.client_name,
        row.invoice_period,
        row.official_line,
        row.value,
        row.brick_id,
        row.area_code,
        row.area_name,
        row.region_code,
        row.region_name,
        row.target.brickId,
        row.target.areaCode,
        row.target.regionCode,
      ]
        .map(cell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function report(rows: PendingRow[]): void {
  const byPeriodLine = new Map<string, { rows: number; value: number; movingArea: number }>();
  for (const row of rows) {
    const key = `${row.invoice_period ?? "(no period)"}  ${normalizedLine(row.official_line) || "(no line)"}`;
    const entry = byPeriodLine.get(key) ?? { rows: 0, value: 0, movingArea: 0 };
    entry.rows += 1;
    entry.value += Number(row.value ?? 0);
    if (String(row.area_code ?? "") !== String(row.target.areaCode ?? "")) entry.movingArea += 1;
    byPeriodLine.set(key, entry);
  }
  console.log("\nRows that will be re-pointed, by period and line:");
  for (const [key, entry] of [...byPeriodLine.entries()].sort()) {
    console.log(
      `  ${key.padEnd(26)} ${String(entry.rows).padStart(6)} rows  ${money(entry.value).padStart(16)} EGP  (${entry.movingArea} change area)`,
    );
  }

  const net = new Map<string, number>();
  for (const row of rows) {
    if (normalizedLine(row.official_line) !== line || row.invoice_period !== period) continue;
    const from = String(row.area_code ?? "(none)");
    const to = String(row.target.areaCode ?? "(none)");
    if (from === to) continue;
    net.set(from, (net.get(from) ?? 0) - Number(row.value ?? 0));
    net.set(to, (net.get(to) ?? 0) + Number(row.value ?? 0));
  }
  console.log(`\nNet ${line.toUpperCase()} ${period} value moving between areas (own sales only — the Office spread re-runs on top):`);
  for (const [area, delta] of [...net.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 20)) {
    console.log(`  ${area.padEnd(10)} ${(delta >= 0 ? "+" : "") + money(delta)} EGP`);
  }
  const total = [...net.values()].reduce((sum, value) => sum + value, 0);
  console.log(`  ${"NET".padEnd(10)} ${money(total)} EGP  (must be 0.00 — value only moves between areas, it is never created)`);
}

// A published month stops an APPLY dead. A dry run reports instead: tonight's September repair
// (2026-10-09) was measured on a dry run before the owner unpublished the month, which is the
// correct order and must stay possible.
function enforcePublishedMonthRule(risk: PublishedMonthRisk): void {
  if (publishedMonthRiskIsClear(risk)) return;
  const message = publishedMonthGuardMessage(risk);
  if (apply) throw new Error(message);
  console.log(`\nWOULD BE REFUSED ON --apply — ${message}`);
}

async function main(): Promise<void> {
  console.log(`${apply ? "APPLYING" : "DRY RUN, nothing will be written"} — period ${period}, line ${line}, actor ${actorLoginId}`);

  const publishedPeriods = await livePublishedPeriods(supabase);
  console.log(
    `Published closing month(s): ${[...publishedPeriods].sort().join(", ") || "none"} — a run that would write into one is refused.`,
  );
  enforcePublishedMonthRule(
    findPublishedMonthsAtRisk({ targetPeriod: period, publishedPeriods, rowPeriods: [] }),
  );

  const batchIds = await periodBatchIds();
  if (batchIds.length === 0) throw new Error(`No validated file for period ${period}.`);
  const map = await activeMap();
  console.log(`${batchIds.length} validated file(s) in ${period}; ${map.size} active customer mappings with a brick.`);

  const pairs = await pairsToRepair(batchIds, map);
  if (pairs.size === 0) {
    console.log(`\nEvery ${line.toUpperCase()} row in ${period} already agrees with the active map. Nothing to do.`);
    return;
  }
  console.log(`${pairs.size} (distributor, customer) pair(s) disagree with the active map.`);

  const { rows, frozenBatches } = await rowsThatWillChange(pairs);
  if (frozenBatches.size > 0) {
    console.log(`\n${frozenBatches.size} file(s) hold a row in a LOCKED closing and are skipped whole by the repair:`);
    for (const batchId of [...frozenBatches].sort()) console.log(`  ${batchId}`);
  }
  report(rows);

  await mkdir(dirname(preimagePath), { recursive: true });
  await writeFile(preimagePath, csv(rows), "utf8");
  console.log(`\nPre-image of all ${rows.length} row(s) written to ${preimagePath}`);

  // The RPC is keyed on (distributor, customer) and ignores the period, so the rows it would
  // rewrite — not the period asked for — are what has to be clear of every published month.
  const rowRisk = findPublishedMonthsAtRisk({
    targetPeriod: period,
    publishedPeriods,
    rowPeriods: rows.map((row) => row.invoice_period),
  });
  if (publishedMonthRiskIsClear(rowRisk)) {
    console.log(`\nPublished-month guard: clear — none of the ${rows.length} row(s) sit in a published month.`);
  } else {
    enforcePublishedMonthRule(rowRisk);
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing was written. Re-run with --apply to perform the repair.");
    return;
  }

  let updatedRows = 0;
  const affected = new Set<string>();
  let done = 0;
  for (const key of pairs.keys()) {
    const [distributorCode, customerCode] = key.split("|");
    const { data, error } = await supabase.rpc("sos_reconcile_import_rows_from_customer_map", {
      p_distributor: distributorCode,
      p_customer: customerCode,
    });
    if (error) throw new Error(`re-resolving ${distributorCode} / ${customerCode}: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
    updatedRows += Number(row?.updated_rows ?? 0) || 0;
    const batchIdsBack = Array.isArray(row?.affected_batch_ids) ? (row?.affected_batch_ids as unknown[]) : [];
    for (const batchId of batchIdsBack) affected.add(String(batchId));
    done += 1;
    if (done % 100 === 0) console.log(`  ${done}/${pairs.size} pairs — ${updatedRows} row(s) re-pointed so far`);
  }
  console.log(`\n${updatedRows} row(s) re-pointed across ${affected.size} file(s). Rebuilding each file's totals once.`);

  for (const batchId of [...affected].sort()) {
    const started = Date.now();
    await refreshBatchRollups(supabase, batchId, (step, message) => new Error(`${step} for file ${batchId}: ${message}`));
    console.log(`  rebuilt ${batchId} in ${Math.round((Date.now() - started) / 1000)}s`);
  }

  await writeAuditLog({
    actorLoginId,
    entityId: "source_of_sales_import_rows",
    entityType: "sales_import_batch",
    newValues: {
      period,
      line,
      pairs: pairs.size,
      updated_rows: updatedRows,
      affected_batch_ids: [...affected].sort(),
      frozen_batch_ids: [...frozenBatches].sort(),
      preimage_file: preimagePath,
    },
    summary: `Customer-map reconciliation — ${updatedRows} row(s) re-pointed for ${pairs.size} customer(s) seeded from ${line.toUpperCase()} ${period}, across ${affected.size} file(s).`,
  });

  console.log("\nDone. The Source of Sales dashboard caches carry a 300s TTL and catch up on their own.");
}

await main();
