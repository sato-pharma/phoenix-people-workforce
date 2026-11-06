import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadMovedBricks } from "@/lib/sales/master-data/moved-bricks";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { addressBrickFinding, type AddressFindingKind, type AddressMaps } from "@/lib/sales/normalizer/address-brick";
import { addCustomerMapRow } from "@/lib/sales/normalizer/customer-map";
import { normalizeCodeKey, numericCanonicalKey } from "@/lib/sales/normalizer/resolvers";
import type { BrickRef } from "@/lib/sales/normalizer/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// THE WRONG-TOWN FINDER (owner, 2026-11-03). Lists the pharmacies whose address names another town
// than their brick, for a person to rule on. It moves nothing by itself, and no import reads it.
//
// The map is over 100,000 active rows and a full pass is too heavy for one web request, so the browser
// walks it a page at a time and the list fills as it goes. No table, no cron, no stored result.
// Sales are shown as PRESENCE only, rows and months and never a value: every sales figure a person
// reads comes from Monthly Closing, and this screen only has to say whether the move touches sales.

const TABLE = "source_of_sales_customer_map";
const COLUMNS = "id,distributor_code,customer_code,customer_name,address,brick_id,source,confidence,updated_at";
const PAGE_SIZE = 2000;
const MAPS_TTL_MS = 5 * 60 * 1000;
/** Ibn Sina sends one pharmacy under three copies, and a ruling on one does not reach the others. */
const IBN_SINA_COPIES = ["IS", "IS-S", "IS-L"];

type MapRow = {
  address: string | null;
  brick_id: string | null;
  confidence: number | null;
  customer_code: string;
  customer_name: string | null;
  distributor_code: string;
  id: number;
  source: string | null;
  updated_at: string | null;
};

export type AddressFindingBrick = { areaName: string; brickId: string; brickName: string };

export type AddressFindingRow = {
  address: string;
  current: AddressFindingBrick;
  customerCode: string;
  customerName: string;
  distributorCode: string;
  id: number;
  kind: AddressFindingKind;
  nextUploadMoves: boolean;
  /** null means the read failed, which is not the same as no sales. */
  sales: { months: number; rows: number } | null;
  suggested: AddressFindingBrick;
  /** The same pharmacy at another Ibn Sina copy; null means the read failed. */
  twins: { brickName: string; customerCode: string; distributorCode: string }[] | null;
  updatedAt: string | null;
};

let cachedMaps: { at: number; maps: AddressMaps } | null = null;

async function loadAddressMaps(): Promise<AddressMaps> {
  if (cachedMaps && Date.now() - cachedMaps.at < MAPS_TTL_MS) return cachedMaps.maps;
  const [refs, moved] = await Promise.all([loadSalesReferenceData({ includeCustomerBricks: false }), loadMovedBricks()]);
  const brickById = new Map<string, BrickRef>((refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), {
    areaCode: normalizeCodeKey(b.areaCode), areaName: b.areaName, blockCode: b.blockCode, blockName: b.blockName,
    brickId: normalizeCodeKey(b.brickId), brickName: b.brickName, regionCode: normalizeCodeKey(b.regionCode), regionName: b.regionName,
  }]));
  const maps: AddressMaps = { brickById, movedBrickIds: new Set([...moved.keys()].map(normalizeCodeKey)) };
  cachedMaps = { at: Date.now(), maps };
  return maps;
}

/** A customer code as the sales tables may hold it: Pharma Overseas pads its codes to ten digits. */
function codeForms(code: string): string[] {
  const canon = numericCanonicalKey(code);
  return canon ? [...new Set([code, canon, canon.padStart(10, "0")])] : [code];
}

const sameCode = (a: string, b: string) => {
  const ca = numericCanonicalKey(a);
  return ca ? ca === numericCanonicalKey(b) : normalizeCodeKey(a) === normalizeCodeKey(b);
};

async function readSales(rows: MapRow[]): Promise<Map<number, { months: number; rows: number }> | null> {
  const distributors = [...new Set(rows.map((r) => r.distributor_code))];
  const clientCodes = rows.flatMap((r) => codeForms(r.customer_code));
  type SalesRow = { client_code: unknown; distributor_code: unknown; id: number; period: unknown; rows_all: unknown };
  let data: SalesRow[];
  try {
    // Keyset-paged: one read stops at a fixed row count with no error, and a short answer here reads as less sales.
    data = await fetchAllRowsKeyset<SalesRow>(
      () =>
        getSupabaseAdmin()
          .from("source_of_sales_channel_customer_rollup")
          .select("id,distributor_code,client_code,period,rows_all")
          .in("distributor_code", distributors)
          .in("client_code", clientCodes),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    );
  } catch {
    return null;
  }
  const out = new Map<number, { months: number; rows: number }>();
  for (const row of rows) {
    const mine = data.filter((s) => s.distributor_code === row.distributor_code && sameCode(String(s.client_code), row.customer_code));
    out.set(row.id, {
      months: new Set(mine.map((s) => s.period)).size,
      rows: mine.reduce((sum, s) => sum + (Number(s.rows_all) || 0), 0),
    });
  }
  return out;
}

async function readTwins(rows: MapRow[], maps: AddressMaps): Promise<Map<number, AddressFindingRow["twins"]> | null> {
  const copies = rows.filter((r) => IBN_SINA_COPIES.includes(r.distributor_code));
  const out = new Map<number, AddressFindingRow["twins"]>(rows.map((r) => [r.id, []]));
  if (!copies.length) return out;
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("distributor_code,customer_code,brick_id")
    .eq("active", true)
    .in("distributor_code", IBN_SINA_COPIES)
    .in("customer_code", copies.flatMap((r) => codeForms(r.customer_code)));
  if (error) return null;
  for (const row of copies) {
    out.set(row.id, (data ?? [])
      .filter((t) => t.distributor_code !== row.distributor_code && sameCode(String(t.customer_code), row.customer_code))
      .map((t) => ({
        brickName: maps.brickById.get(normalizeCodeKey(t.brick_id))?.brickName ?? String(t.brick_id ?? ""),
        customerCode: String(t.customer_code),
        distributorCode: String(t.distributor_code),
      })));
  }
  return out;
}

const asFindingBrick = (b: BrickRef): AddressFindingBrick => ({ areaName: b.areaName ?? b.areaCode, brickId: b.brickId, brickName: b.brickName });

/** One page of the walk, from the row after `after`. */
export async function scanAddressFindings(input: { after: number }): Promise<{
  done: boolean;
  findings: AddressFindingRow[];
  nextAfter: number;
  scanned: number;
}> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select(COLUMNS)
    .eq("active", true)
    .gt("id", input.after)
    .order("id", { ascending: true })
    .limit(PAGE_SIZE);
  if (error) throw new SalesWorkflowError("read_failed", "Could not read the customer map.", 500);
  const page = (data ?? []) as unknown as MapRow[];
  const maps = await loadAddressMaps();

  const flagged: { finding: NonNullable<ReturnType<typeof addressBrickFinding>>; row: MapRow }[] = [];
  for (const row of page) {
    // In the app, not in the query: a `neq` would also drop every row whose confidence is null.
    if (Number(row.confidence) === 100 || !row.brick_id) continue;
    const finding = addressBrickFinding(
      { addressValues: [row.address], currentBrickId: row.brick_id, distributorCode: row.distributor_code },
      maps,
    );
    if (finding) flagged.push({ finding, row });
  }

  const rows = flagged.map((f) => f.row);
  const [sales, twins] = rows.length ? await Promise.all([readSales(rows), readTwins(rows, maps)]) : [null, null];
  return {
    // Only an empty page ends the walk. A short one proves nothing: PostgREST can cap a page below
    // PAGE_SIZE, and stopping there would call the whole map read with most of it unread.
    done: page.length === 0,
    findings: flagged.map(({ finding, row }) => ({
      address: String(row.address ?? ""),
      current: asFindingBrick(maps.brickById.get(normalizeCodeKey(row.brick_id))!),
      customerCode: row.customer_code,
      customerName: String(row.customer_name ?? ""),
      distributorCode: row.distributor_code,
      id: row.id,
      kind: finding.kind,
      nextUploadMoves: finding.nextUploadMoves,
      sales: sales?.get(row.id) ?? null,
      suggested: asFindingBrick(finding.brick),
      twins: twins ? twins.get(row.id) ?? [] : null,
      updatedAt: row.updated_at,
    })),
    nextAfter: page.length ? page[page.length - 1].id : input.after,
    scanned: page.length,
  };
}

/**
 * Why this row may not be ruled on now, or null when it may. The screen can sit open for an hour and
 * an upload can move a row meanwhile: a ruling is on the row the person read, never on what it became.
 */
export function addressRulingRefusal(
  row: { active?: boolean | null; brick_id: string | null; confidence: number | null; updated_at: string | null } | null,
  expected: { brickId: string; updatedAt: string | null },
): string | null {
  if (!row || row.active === false) return "This mapping no longer exists.";
  if (Number(row.confidence) === 100) return "This mapping is already a ruling.";
  if (normalizeCodeKey(row.brick_id) !== normalizeCodeKey(expected.brickId) || row.updated_at !== expected.updatedAt) {
    return "This mapping changed after the list was read. Read the list again.";
  }
  return null;
}

/** A Move goes to the brick the person read, or nowhere: the brick master can change while the screen is open. */
export function moveTargetRefusal(foundBrickId: string | null, expectedTargetBrickId: string | null | undefined): string | null {
  if (!foundBrickId) return "The address no longer points to another town.";
  if (normalizeCodeKey(foundBrickId) !== normalizeCodeKey(expectedTargetBrickId)) {
    return "The address now points to another brick. Read the list again.";
  }
  return null;
}

/** A ruling sticks: confidence 100, so no upload re-decides it. Move also heals the unpublished history. */
export async function ruleOnAddressFinding(input: {
  actorLoginId: string;
  decision: "keep" | "move";
  expectedBrickId: string;
  /** The brick the screen named. Required for a Move. */
  expectedTargetBrickId?: string | null;
  expectedUpdatedAt: string | null;
  id: number;
}): Promise<{ backfilled: number; brickName: string }> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select(`${COLUMNS},active,area_code,region_code,mapped_by`)
    .eq("id", input.id)
    .maybeSingle();
  if (error) throw new SalesWorkflowError("read_failed", "Could not read the mapping.", 500);
  const row = data as unknown as (MapRow & { active: boolean | null; area_code: string | null; mapped_by: string | null; region_code: string | null }) | null;
  const refusal = addressRulingRefusal(row, { brickId: input.expectedBrickId, updatedAt: input.expectedUpdatedAt });
  if (refusal || !row) throw new SalesWorkflowError("stale_finding", refusal ?? "This mapping no longer exists.", 409);

  const maps = await loadAddressMaps();
  let brickId = normalizeCodeKey(row.brick_id);
  if (input.decision === "move") {
    // The server re-reads the address: the target is never what the browser says it is.
    const finding = addressBrickFinding({ addressValues: [row.address], currentBrickId: brickId, distributorCode: row.distributor_code }, maps);
    const moveRefusal = moveTargetRefusal(finding?.brick.brickId ?? null, input.expectedTargetBrickId);
    if (moveRefusal || !finding) throw new SalesWorkflowError("stale_finding", moveRefusal ?? "The address no longer points to another town.", 409);
    brickId = finding.brick.brickId;
  }
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const { backfilled } = await addCustomerMapRow({
    actorLoginId: input.actorLoginId,
    address: row.address ?? undefined,
    backfill: input.decision === "move",
    brickId,
    customerCode: row.customer_code,
    customerName: row.customer_name ?? undefined,
    distributorCode: row.distributor_code,
    ruling: {
      before: { area_code: row.area_code, brick_id: row.brick_id, confidence: row.confidence, mapped_by: row.mapped_by, region_code: row.region_code, source: row.source },
      source: `owner-finder-ruling-${date}`,
    },
  });
  return { backfilled, brickName: maps.brickById.get(brickId)?.brickName ?? brickId };
}
