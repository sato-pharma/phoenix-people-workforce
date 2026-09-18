// Pure: what the Database Mapping page's "Correct in database" panel shows for one brick, read from
// the master rows the page already holds. The Source Normalizer's Area column links here (see
// brickCorrectionHref); the owner fixes a brick filed under the wrong area by picking the area it
// really belongs to, then the block inside that area, because a brick's area is always its block's.
//
// No database access, so the client panel and the tests share one definition.

import { followMovedBrick } from "@/lib/sales/normalizer/brick-area";

import { normalizeCode, normalizeDisplay, type MasterRowRecord } from "./definitions";

export type BrickMasterRows = {
  areas: MasterRowRecord[];
  blocks: MasterRowRecord[];
  bricks: MasterRowRecord[];
  regions: MasterRowRecord[];
};

export type CorrectionChoice = { label: string; value: string };

/** An area on the list, with its bare name for the Move button. */
export type AreaChoice = CorrectionChoice & { name: string };

/** The brick the panel was opened on, in the state the master holds it. */
export type BrickCorrectionSubject =
  | { kind: "missing" }
  | { kind: "history"; brickName: string; successorId: string; successorName: string }
  | { kind: "off"; brickName: string }
  | {
      kind: "live";
      areaCode: string;
      areaName: string;
      blockCode: string;
      blockName: string;
      brickId: string;
      brickName: string;
      regionName: string;
    };

function brickNamesById(bricks: MasterRowRecord[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const brick of bricks) {
    const id = normalizeDisplay(brick.brick_id);
    if (id) names.set(id, normalizeDisplay(brick.brick_name));
  }
  return names;
}

function namesByCode(rows: MasterRowRecord[], codeColumn: string, nameColumn: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const code = normalizeCode(row[codeColumn]);
    const name = normalizeDisplay(row[nameColumn]);
    if (code && name) names.set(code, name);
  }
  return names;
}

/**
 * A block's name, the way the move itself reports it (sos_relocate_brick): its display name, else the
 * name of the brick it was named after, else its description, else its code.
 */
export function blockName(block: MasterRowRecord, brickNames: ReadonlyMap<string, string>): string {
  return (
    normalizeDisplay(block.display_name)
    || brickNames.get(normalizeDisplay(block.master_brick_id))
    || normalizeDisplay(block.description)
    || normalizeDisplay(block.block_code)
  );
}

function isActive(row: MasterRowRecord): boolean {
  return row.active !== false;
}

function byLabel(a: CorrectionChoice, b: CorrectionChoice): number {
  return a.label.localeCompare(b.label) || a.value.localeCompare(b.value);
}

/** The blocks a brick in `currentBlockCode` may move to: switched on, and not the one it is in. */
function movableBlocks(rows: BrickMasterRows, currentBlockCode: string): MasterRowRecord[] {
  const current = normalizeCode(currentBlockCode);
  return rows.blocks.filter((block) => isActive(block) && normalizeCode(block.block_code) !== current);
}

/**
 * Step one: the area the brick really belongs to. Every switched-on area holding a block the brick
 * may move to, named "<area> — <region>". Its own area stays on the list, marked, for a brick that
 * sits in the wrong block of the right area.
 */
export function areaChoices(rows: BrickMasterRows, currentBlockCode: string): AreaChoice[] {
  const areaNames = namesByCode(rows.areas, "area_code", "area_name");
  const regionNames = namesByCode(rows.regions, "region_code", "region_name");
  const activeAreas = new Map<string, MasterRowRecord>();
  for (const area of rows.areas) {
    if (isActive(area)) activeAreas.set(normalizeCode(area.area_code), area);
  }
  const currentBlock = rows.blocks.find((block) => normalizeCode(block.block_code) === normalizeCode(currentBlockCode));
  const currentArea = currentBlock ? normalizeCode(currentBlock.area_code) : "";
  const seen = new Set<string>();
  const choices: AreaChoice[] = [];
  for (const block of movableBlocks(rows, currentBlockCode)) {
    const areaCode = normalizeCode(block.area_code);
    const area = activeAreas.get(areaCode);
    if (!area || seen.has(areaCode)) continue;
    seen.add(areaCode);
    const regionName = regionNames.get(normalizeCode(block.region_code)) ?? regionNames.get(normalizeCode(area.region_code)) ?? "";
    const name = areaNames.get(areaCode) ?? areaCode;
    const label = regionName ? `${name} — ${regionName}` : name;
    choices.push({ label: areaCode === currentArea ? `${label} (where it is now)` : label, name, value: areaCode });
  }
  return choices.sort(byLabel);
}

/** Step two: the block inside the chosen area, by name. */
export function blockChoicesInArea(rows: BrickMasterRows, areaCode: string, currentBlockCode: string): CorrectionChoice[] {
  const area = normalizeCode(areaCode);
  if (!area) return [];
  const brickNames = brickNamesById(rows.bricks);
  return movableBlocks(rows, currentBlockCode)
    .filter((block) => normalizeCode(block.area_code) === area)
    .map((block) => ({ label: blockName(block, brickNames), value: normalizeDisplay(block.block_code) }))
    .sort(byLabel);
}

/** The brick behind `brickId`, as the panel explains it. */
export function brickCorrectionSubject(rows: BrickMasterRows, brickId: string): BrickCorrectionSubject {
  const wanted = normalizeDisplay(brickId);
  const brick = rows.bricks.find((row) => normalizeDisplay(row.brick_id) === wanted);
  if (!wanted || !brick) return { kind: "missing" };
  const brickName = normalizeDisplay(brick.brick_name) || wanted;

  if (normalizeDisplay(brick.superseded_by_brick_id)) {
    const moved: Record<string, string> = {};
    for (const row of rows.bricks) {
      const next = normalizeDisplay(row.superseded_by_brick_id);
      if (next) moved[normalizeDisplay(row.brick_id)] = next;
    }
    const successorId = followMovedBrick(wanted, moved);
    const successorName = brickNamesById(rows.bricks).get(successorId) || successorId;
    return { brickName, kind: "history", successorId, successorName };
  }
  if (!isActive(brick)) return { brickName, kind: "off" };

  const blockCode = normalizeDisplay(brick.block_code);
  const block = rows.blocks.find((row) => normalizeCode(row.block_code) === normalizeCode(blockCode));
  const areaCode = normalizeCode(brick.area_code);
  return {
    areaCode,
    areaName: namesByCode(rows.areas, "area_code", "area_name").get(areaCode) ?? "",
    blockCode,
    blockName: block ? blockName(block, brickNamesById(rows.bricks)) : "",
    brickId: wanted,
    brickName,
    kind: "live",
    regionName: namesByCode(rows.regions, "region_code", "region_name").get(normalizeCode(brick.region_code)) ?? "",
  };
}
