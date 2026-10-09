// The held-changes sheet, server half: read the live holds for the export, check an uploaded sheet
// against them for the preview, and write the confirmed answers through the guard's own decide path.
// The pure half (building, reading and planning) is `mapping-guard-workbook.ts`.
//
// NOTHING HERE OPENS A BACK DOOR. The guard exists so that a writer cannot move a customer the owner
// ruled on; this module is a writer like any other, so it never sets the bypass and never mints a
// permit. Allow and Keep go through `decideMappingHold` (the RPC the review screen presses). A custom
// brick goes in as an ordinary update, which the guard holds like anyone's, and the hold it makes is
// then approved through the same RPC — the route a person takes by hand, and the one that undid hold
// 3542 on 2026-10-10.
//
// ORDER OF A MOVE (each step leaves the original hold pending if the next one fails):
//   1. snapshot the pending holds on the row,
//   2. update the row to the chosen brick (the guard answers: held, or applied outright),
//   3. approve the ONE new hold, with the lock if he asked for one,
//   4. only then refuse the ORIGINAL hold, which the move has made moot.

import { logError } from "@/lib/observability/log";
import { writeMappingAudit } from "@/lib/sales/mapping-audit";
import { decideMappingHold, listHeldMappingChanges } from "@/lib/sales/mapping-guard";
import {
  CUSTOMER_MAP_TABLE,
  currentCairoPeriod,
  describeMonth,
  loadHoldDetails,
  summarizeHoldSales,
  TRACKED_IMPACT_LINES,
  type HoldDetail,
  type HoldSalesImpactRow,
} from "@/lib/sales/mapping-guard-detail";
import type {
  GuardApplyOutcome,
  GuardGeo,
  GuardInstruction,
  GuardPlan,
} from "@/lib/sales/mapping-guard-sheet-shape";
import {
  guardPageDigest,
  planGuardAnswers,
  sheetRowsFromInstructions,
  type GuardLiveHold,
  type GuardSheetRow,
  type ParsedSheetRow,
} from "@/lib/sales/mapping-guard-workbook";
import type { BrickSalesMove } from "@/lib/sales/master-data/brick-move-result";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The screen lists at most this many, and so does the sheet, so the two always show the same rows. */
export const GUARD_SHEET_MAX_HOLDS = 500;

const IN_CHUNK = 100;
const PAGE = 1000;

type BrickRecord = GuardGeo & { active: boolean };

type Geography = {
  /** Every brick, switched off or not — a customer can sit in one that is switched off now. */
  all: Map<string, BrickRecord>;
  /** Active bricks only, in the order the Bricks sheet prints them. */
  active: GuardGeo[];
  activeById: Map<string, GuardGeo>;
};

type MapRecord = {
  id: number;
  distributor_code: string | null;
  customer_code: string | null;
  customer_name: string | null;
  address: string | null;
  brick_id: string | null;
  area_code: string | null;
  region_code: string | null;
  source: string | null;
  confidence: number | string | null;
};

function key(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function chunked<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────

async function readAll<T>(table: string, columns: string, filter?: (query: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let query: any = getSupabaseAdmin().from(table).select(columns); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (filter) query = filter(query);
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

export async function loadGeography(): Promise<Geography> {
  const [bricks, areas, regions] = await Promise.all([
    readAll<{ brick_id: string; brick_name: string | null; area_code: string | null; region_code: string | null; active: boolean | null }>(
      "source_of_sales_bricks",
      "brick_id,brick_name,area_code,region_code,active",
      (query) => query.order("brick_id", { ascending: true }),
    ),
    readAll<{ area_code: string; area_name: string | null }>("source_of_sales_areas", "area_code,area_name"),
    readAll<{ region_code: string; region_name: string | null }>("source_of_sales_regions", "region_code,region_name"),
  ]);
  const areaName = new Map(areas.map((row) => [key(row.area_code), String(row.area_name ?? "").trim()]));
  const regionName = new Map(regions.map((row) => [key(row.region_code), String(row.region_name ?? "").trim()]));

  const all = new Map<string, BrickRecord>();
  const active: GuardGeo[] = [];
  const activeById = new Map<string, GuardGeo>();
  for (const row of bricks) {
    const brickId = String(row.brick_id ?? "").trim();
    if (!brickId) continue;
    const areaCode = String(row.area_code ?? "").trim();
    const regionCode = String(row.region_code ?? "").trim();
    const geo: GuardGeo = {
      areaCode,
      areaName: areaName.get(key(areaCode)) ?? "",
      brickId,
      brickName: String(row.brick_name ?? "").trim(),
      regionCode,
      regionName: regionName.get(key(regionCode)) ?? "",
    };
    const isActive = row.active !== false;
    all.set(key(brickId), { ...geo, active: isActive });
    if (isActive) {
      active.push(geo);
      activeById.set(key(brickId), geo);
    }
  }
  return { active, activeById, all };
}

function geoOf(geography: Geography, brickId: string, map?: Pick<MapRecord, "area_code" | "region_code">): GuardGeo | null {
  const id = key(brickId);
  if (!id) return null;
  const found = geography.all.get(id);
  if (found) {
    return {
      areaCode: found.areaCode,
      areaName: found.areaName,
      brickId: found.brickId,
      brickName: found.brickName,
      regionCode: found.regionCode,
      regionName: found.regionName,
    };
  }
  // A brick the master no longer lists: keep the id he can see, and the codes the row itself carries.
  return {
    areaCode: String(map?.area_code ?? "").trim(),
    areaName: "",
    brickId: id,
    brickName: "",
    regionCode: String(map?.region_code ?? "").trim(),
    regionName: "",
  };
}

async function readMapRecords(rowIds: readonly number[]): Promise<Map<number, MapRecord>> {
  const out = new Map<number, MapRecord>();
  for (const part of chunked([...new Set(rowIds)])) {
    const { data, error } = await getSupabaseAdmin()
      .from(CUSTOMER_MAP_TABLE)
      .select("id,distributor_code,customer_code,customer_name,address,brick_id,area_code,region_code,source,confidence")
      .in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as MapRecord[]) out.set(Number(row.id), row);
  }
  return out;
}

function isRuling(map: MapRecord | undefined): boolean {
  return Number(map?.confidence ?? 0) >= 100;
}

const VERDICT_TEXT: Record<string, string> = {
  "agrees-with-change": "Agrees with the held change",
  "agrees-with-mapping": "Agrees with where it sits now",
  "third-answer": "A third answer: neither side",
  none: "",
};

function filedLine(fact: HoldDetail["filed"][number]): string {
  const brick = fact.filedBrickName || fact.filedBrickId || "";
  return [
    describeMonth(fact.period),
    fact.filedName,
    fact.filedAddress,
    brick ? `brick ${brick}` : "",
    fact.filedArea,
    fact.filedRegion,
  ]
    .filter((part) => part && String(part).trim())
    .join(" | ");
}

/** Everything the export prints: the same holds, details and names the review screen shows. */
export async function loadGuardSheetData(): Promise<{
  rows: GuardSheetRow[];
  bricks: GuardGeo[];
  /** Pending holds on a brick or an area, which have no customer to answer here. */
  otherPending: number;
}> {
  const holds = await listHeldMappingChanges(GUARD_SHEET_MAX_HOLDS);
  const customerHolds = holds.filter((hold) => hold.tableName === CUSTOMER_MAP_TABLE && hold.rowId > 0);
  const [geography, details, maps] = await Promise.all([
    loadGeography(),
    loadHoldDetails(customerHolds),
    readMapRecords(customerHolds.map((hold) => hold.rowId)),
  ]);

  const distributorNameOf = (detail: HoldDetail | undefined, code: string) => detail?.distributorName || code;

  const rows: GuardSheetRow[] = customerHolds.map((hold) => {
    const detail = details[hold.id];
    const map = maps.get(hold.rowId);
    const nowBrickId = key(map?.brick_id);
    const [latest, ...older] = detail?.filed ?? [];
    return {
      customerAddress: detail?.storedAddress ?? String(map?.address ?? "").trim(),
      customerCode: String(map?.customer_code ?? "").trim(),
      customerName: detail?.storedName || String(map?.customer_name ?? "").trim() || hold.subject,
      distributor: distributorNameOf(detail, String(map?.distributor_code ?? "").trim()),
      distributorCode: String(map?.distributor_code ?? "").trim(),
      filed: latest
        ? {
            address: latest.filedAddress ?? "",
            area: latest.filedArea ?? "",
            brick: latest.filedBrickName || latest.filedBrickId || "",
            governorate: latest.filedRegion ?? "",
            name: latest.filedName ?? "",
            period: describeMonth(latest.period),
          }
        : null,
      holdId: hold.id,
      now: geoOf(geography, nowBrickId, map),
      nowBrickId,
      otherFiled: older.map(filedLine),
      ownerRuling: isRuling(map),
      reasons: hold.reasons,
      restatedValue: detail?.sales?.restatedValue ?? 0,
      suggested: detail?.suggestion
        ? {
            brick: detail.suggestion.label,
            brickId: detail.suggestion.brickId,
            verdict: VERDICT_TEXT[detail.suggestion.verdict] ?? "",
          }
        : null,
      trackedValue: detail?.sales?.trackedValue ?? 0,
      wanted: geoOf(geography, hold.toBrickId),
    };
  });

  return { bricks: geography.active, otherPending: holds.length - customerHolds.length, rows };
}

// ── Checking an answer against live state ──────────────────────────────────────────────────────

type LiveHoldContext = { live: GuardLiveHold; map: MapRecord; entityKey: string };

async function readImpact(holdIds: readonly number[]): Promise<Map<number, { tracked: number; restated: number }>> {
  const out = new Map<number, { tracked: number; restated: number }>();
  const impacts: HoldSalesImpactRow[] = [];
  try {
    for (const part of chunked(holdIds, 50)) {
      const { data, error } = await getSupabaseAdmin().rpc("sos_map_hold_sales_impact", {
        p_hold_ids: part,
        p_lines: [...TRACKED_IMPACT_LINES],
      });
      if (error) throw error;
      for (const row of (data ?? []) as Array<{ hold_id: number; period: string; tracked_value: number | string; row_count: number | string }>) {
        impacts.push({
          holdId: Number(row.hold_id),
          period: String(row.period ?? ""),
          rowCount: Number(row.row_count ?? 0),
          trackedValue: Number(row.tracked_value ?? 0),
        });
      }
    }
  } catch (error) {
    // The money is information on the preview, never a reason to refuse an answer.
    logError("Mapping guard sheet: the sales behind the holds could not be read", {
      labels: { event: "mapping_guard_sheet_impact_failed" },
      error,
    });
    return out;
  }
  const summary = summarizeHoldSales(impacts, currentCairoPeriod());
  for (const [holdId, sales] of summary) {
    out.set(holdId, { restated: sales.restatedValue, tracked: sales.trackedValue });
  }
  return out;
}

/** The pending customer-mapping holds among `holdIds`, with the live row each one is about. */
async function loadLiveHolds(
  holdIds: readonly number[],
  geography: Geography,
): Promise<Map<number, LiveHoldContext>> {
  const wanted = [...new Set(holdIds)];
  const holdRows: Array<{ id: number; row_id: number | null; entity_key: string; after_json: Record<string, unknown> | null }> = [];
  for (const part of chunked(wanted)) {
    const { data, error } = await getSupabaseAdmin()
      .from("sos_map_change_holds")
      .select("id,row_id,entity_key,after_json")
      .in("id", part)
      .eq("status", "pending")
      .eq("table_name", CUSTOMER_MAP_TABLE);
    if (error) throw error;
    holdRows.push(...((data ?? []) as unknown as typeof holdRows));
  }

  const maps = await readMapRecords(holdRows.map((row) => Number(row.row_id ?? 0)).filter((id) => id > 0));
  const impact = await readImpact(holdRows.map((row) => row.id));

  const out = new Map<number, LiveHoldContext>();
  for (const row of holdRows) {
    const map = maps.get(Number(row.row_id ?? 0));
    if (!map) continue;
    const liveBrickId = key(map.brick_id);
    const money = impact.get(row.id);
    out.set(row.id, {
      entityKey: row.entity_key,
      live: {
        customer: String(map.customer_name ?? "").trim() || row.entity_key,
        holdId: row.id,
        liveBrickId,
        now: geoOf(geography, liveBrickId, map),
        ownerRuling: isRuling(map),
        restatedValue: money?.restated ?? 0,
        rowId: Number(map.id),
        trackedValue: money?.tracked ?? 0,
        wanted: geoOf(geography, key(row.after_json?.["brick_id"])),
      },
      map,
    });
  }
  return out;
}

async function planAgainstLive(rows: readonly ParsedSheetRow[]): Promise<{ plan: GuardPlan; context: Map<number, LiveHoldContext>; geography: Geography }> {
  const geography = await loadGeography();
  const asked = rows.flatMap((row) => (row.holdId === null ? [] : [row.holdId]));
  const context = await loadLiveHolds(asked, geography);
  const live = new Map<number, GuardLiveHold>([...context].map(([holdId, entry]) => [holdId, entry.live]));
  const plan = planGuardAnswers({ bricks: geography.activeById, live, rows });
  return { context, geography, plan };
}

/** Preview: what an uploaded sheet would do. Writes nothing. */
export async function previewGuardSheet(rows: readonly ParsedSheetRow[]): Promise<GuardPlan> {
  return (await planAgainstLive(rows)).plan;
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────

function cairoDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(now);
}

function messageOf(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? "").trim();
  return message.length > 0 ? message : "That did not go through.";
}

async function pendingHoldIdsOnRow(rowId: number): Promise<Set<number>> {
  const { data, error } = await getSupabaseAdmin()
    .from("sos_map_change_holds")
    .select("id")
    .eq("status", "pending")
    .eq("table_name", CUSTOMER_MAP_TABLE)
    .eq("row_id", rowId);
  if (error) throw error;
  return new Set(((data ?? []) as Array<{ id: number }>).map((row) => Number(row.id)));
}

async function moveToBrick(input: {
  entry: LiveHoldContext;
  instruction: GuardInstruction;
  brick: GuardGeo;
  actor: string;
}): Promise<GuardApplyOutcome> {
  const { entry, instruction, brick, actor } = input;
  const base = { customer: entry.live.customer, holdId: instruction.holdId };
  const supabase = getSupabaseAdmin();

  const before = await pendingHoldIdsOnRow(entry.live.rowId);

  // `.eq("brick_id", …)` with the raw stored value: if anything moved the row since the plan was
  // made, this matches nothing and nothing is overwritten.
  const { error: updateError } = await supabase
    .from(CUSTOMER_MAP_TABLE)
    .update({
      area_code: brick.areaCode,
      brick_id: brick.brickId,
      mapped_by: actor,
      region_code: brick.regionCode,
      updated_at: new Date().toISOString(),
    })
    .eq("id", entry.live.rowId)
    .eq("brick_id", String(entry.map.brick_id ?? ""));
  if (updateError) throw updateError;

  const after = await pendingHoldIdsOnRow(entry.live.rowId);
  const created = [...after].filter((id) => !before.has(id));

  let brickMove: BrickSalesMove | null = null;
  let locked = false;

  if (created.length > 1) {
    return {
      ...base,
      brickMove: null,
      locked: false,
      ok: false,
      reason: `The guard made ${created.length} new holds on this customer (${created.join(", ")}), so none was approved. Decide them on the screen.`,
    };
  }

  if (created.length === 1) {
    const decided = await decideMappingHold({ actor, decision: "approved", holdId: created[0], lock: instruction.lock });
    if (!decided.ok) {
      return {
        ...base,
        brickMove: null,
        locked: false,
        ok: false,
        reason: `The guard held the move as hold ${created[0]} and refused to release it: ${decided.reason ?? "no reason given"}. It is waiting on the screen.`,
      };
    }
    brickMove = decided.brickMove;
    locked = decided.locked;
  } else {
    // No new hold: the guard let the update through outright. Make sure it really landed.
    const { data, error } = await supabase
      .from(CUSTOMER_MAP_TABLE)
      .select("id,brick_id,distributor_code,customer_code")
      .eq("id", entry.live.rowId)
      .maybeSingle();
    if (error) throw error;
    const landed = data as { brick_id: string | null; distributor_code: string | null; customer_code: string | null } | null;
    if (!landed || key(landed.brick_id) !== key(brick.brickId)) {
      return {
        ...base,
        brickMove: null,
        locked: false,
        ok: false,
        reason: "The mapping changed while the answer was being applied, so it was not moved. Export again.",
      };
    }
    if (instruction.lock) {
      const stamp = {
        confidence: 100,
        mapped_by: actor,
        source: `owner-ruling-${cairoDate()}-sheet`,
        updated_at: new Date().toISOString(),
      };
      const { error: lockError } = await supabase.from(CUSTOMER_MAP_TABLE).update(stamp).eq("id", entry.live.rowId);
      if (lockError) throw lockError;
      locked = true;
      await writeMappingAudit({
        action: "edit",
        actor,
        after: { ...stamp, brick_id: brick.brickId },
        before: { brick_id: entry.map.brick_id, confidence: entry.map.confidence, source: entry.map.source },
        distributorCode: landed.distributor_code,
        entityKey: entry.entityKey,
        entityType: "customer_map",
      });
    }
  }

  // The move is done. The hold it was meant to replace is now moot; refuse it WITHOUT a lock so the
  // answer just locked (or not) is the one the customer ends on.
  let warning: string | undefined;
  try {
    const closed = await decideMappingHold({ actor, decision: "rejected", holdId: instruction.holdId, lock: false });
    if (!closed.ok) warning = `The customer moved, but the original hold could not be closed: ${closed.reason ?? "no reason given"}.`;
  } catch (error) {
    warning = `The customer moved, but the original hold could not be closed: ${messageOf(error)}`;
  }

  return { ...base, brickMove, locked, ok: true, warning };
}

async function applyOne(input: {
  instruction: GuardInstruction;
  entry: LiveHoldContext;
  geography: Geography;
  actor: string;
}): Promise<GuardApplyOutcome> {
  const { instruction, entry, geography, actor } = input;
  const base = { customer: entry.live.customer, holdId: instruction.holdId };
  try {
    if (instruction.answer === "move") {
      const brick = geography.activeById.get(key(instruction.moveToBrickId));
      if (!brick) {
        return { ...base, brickMove: null, locked: false, ok: false, reason: `${instruction.moveToBrickId} is not an active brick.` };
      }
      return await moveToBrick({ actor, brick, entry, instruction });
    }
    const decided = await decideMappingHold({
      actor,
      decision: instruction.answer === "allow" ? "approved" : "rejected",
      holdId: instruction.holdId,
      lock: instruction.lock,
    });
    return {
      ...base,
      brickMove: decided.brickMove,
      locked: decided.locked,
      ok: decided.ok,
      reason: decided.ok ? undefined : decided.reason ?? "it had already been decided.",
    };
  } catch (error) {
    return { ...base, brickMove: null, locked: false, ok: false, reason: messageOf(error) };
  }
}

export class GuardPageMismatchError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = "GuardPageMismatchError";
  }
}

/**
 * Apply one confirmed page of answers.
 *
 * The instructions are RE-PLANNED against live state first, and the page is refused unless that plan
 * is exactly the one he confirmed (same rows, same digest). A hold somebody else decided meanwhile, a
 * mapping that moved, a brick switched off: each turns a ready row into a problem, the digest changes,
 * and the page is refused with nothing written — never half of it silently dropped.
 */
export async function applyGuardPage(input: {
  instructions: readonly GuardInstruction[];
  digest: string;
  actor: string;
}): Promise<GuardApplyOutcome[]> {
  const { context, geography, plan } = await planAgainstLive(sheetRowsFromInstructions(input.instructions));

  if (plan.problems.length > 0 || plan.rows.length !== input.instructions.length) {
    const first = plan.problems[0];
    throw new GuardPageMismatchError(
      first
        ? `Something changed since the preview: ${first.customer || `hold ${first.holdId}`} — ${first.reason} Nothing on this page was written. Preview the sheet again.`
        : "Something changed since the preview, so nothing on this page was written. Preview the sheet again.",
    );
  }
  if (guardPageDigest(plan.rows) !== input.digest) {
    throw new GuardPageMismatchError(
      "This page is not the one you previewed, so nothing on it was written. Preview the sheet again.",
    );
  }

  const outcomes: GuardApplyOutcome[] = [];
  for (const instruction of input.instructions) {
    const entry = context.get(instruction.holdId);
    if (!entry) {
      outcomes.push({ brickMove: null, customer: "", holdId: instruction.holdId, locked: false, ok: false, reason: "it is not waiting any more." });
      continue;
    }
    // Sequential, and each row stands alone: one refusal must not undo the answers before it.
    outcomes.push(await applyOne({ actor: input.actor, entry, geography, instruction }));
  }
  return outcomes;
}
