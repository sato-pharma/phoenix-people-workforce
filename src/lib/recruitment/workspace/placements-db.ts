// Recruitment workspace — the placement rows (`ats_candidate_placements`): which role tab, region and
// area a person is filed in. One row per (candidate, tab); no row at all is "Needs placing".
//
// TWO KINDS OF ROW, one table. A row made FROM THE APPLICANT'S ANSWERS — by the bot (`whatsapp`), the
// careers form (`website`), the one-off fill of the people already in the pool (`migration`) — and a
// row HR made (`hr`), either by filing the person by hand or by correcting one of their answers.
//
//   * The answers say ONE thing at a time, so an answers-made placement in a new tab replaces the
//     answers-made rows in every other tab (an applicant who first tapped Medical Rep and then went
//     back and chose District Manager is in District Manager, not in both).
//   * HR's word wins: the bot never overwrites, moves or removes an `hr` row. When HR corrects an
//     answer, the placement that answer gives is HR's (`hr`) and replaces the answers-made rows.
//
// Every write here is best effort for its callers (the webhook and the careers form must never fail
// because a placement could not be written); the functions throw, and `placeFromAnswers` catches.

import { recruitmentRegionForArea } from "@/lib/recruitment/candidate-region";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  placementFromReply,
  validRegionCode,
  type PlacementFromReply,
} from "@/lib/recruitment/workspace/placement-from-reply";
import type { WorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";

const PLACEMENTS_TABLE = "ats_candidate_placements";
const AREA_CACHE_TTL_MS = 10 * 60_000;
const ID_BATCH = 100;

export type PlacedBy = "whatsapp" | "website" | "hr" | "migration";

/** The sources that file a person from their own answers. `hr` is the one that is not. */
export const ANSWER_PLACEMENT_SOURCES: readonly PlacedBy[] = ["whatsapp", "website", "migration"];

export type PlacementRecord = {
  id: string;
  candidateId: string;
  roleTab: WorkspaceRoleTab;
  botRoleFamily: string | null;
  regionCode: string | null;
  areaCode: string | null;
  areaName: string | null;
  placedBy: PlacedBy;
  sessionId: string | null;
  placedByHrId: string | null;
  placedAt: string;
  updatedAt: string;
};

type PlacementDbRow = {
  id: string;
  candidate_id: string;
  role_tab: string;
  bot_role_family: string | null;
  region_code: string | null;
  area_code: string | null;
  area_name: string | null;
  placed_by: string;
  session_id: string | null;
  placed_by_hr_id: string | null;
  placed_at: string;
  updated_at: string;
};

const PLACEMENT_COLUMNS =
  "id,candidate_id,role_tab,bot_role_family,region_code,area_code,area_name,placed_by,session_id,placed_by_hr_id,placed_at,updated_at";

function mapPlacement(row: PlacementDbRow): PlacementRecord {
  return {
    areaCode: row.area_code,
    areaName: row.area_name,
    botRoleFamily: row.bot_role_family,
    candidateId: row.candidate_id,
    id: row.id,
    placedAt: row.placed_at,
    placedBy: row.placed_by as PlacedBy,
    placedByHrId: row.placed_by_hr_id,
    regionCode: row.region_code,
    roleTab: row.role_tab as WorkspaceRoleTab,
    sessionId: row.session_id,
    updatedAt: row.updated_at,
  };
}

// ── The AU area directory ─────────────────────────────────────────────────────────────────────

export type AuArea = { areaCode: string; areaName: string; salesRegionCode: string | null };

let areaCache: { at: number; byCode: Map<string, AuArea>; byName: Map<string, AuArea> } | null = null;

function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Test seam, and the way to pick up an area rename without waiting out the ten minutes. */
export function resetPlacementAreaCache(): void {
  areaCache = null;
}

/** Active AU areas by code and by name. READ THE PUBLIC VIEW — `.schema("au")` answers PGRST106. */
async function loadAuAreas(): Promise<NonNullable<typeof areaCache>> {
  if (areaCache && Date.now() - areaCache.at < AREA_CACHE_TTL_MS) return areaCache;
  const { data, error } = await recruitmentDb()
    .from("au_v_canonical_areas")
    .select("area_code,area_name,code_region_code,is_active")
    .eq("is_active", true);
  if (error) throw error;
  const byCode = new Map<string, AuArea>();
  const byName = new Map<string, AuArea>();
  for (const raw of (data ?? []) as Array<{ area_code: string | null; area_name: string | null; code_region_code: string | null }>) {
    const code = String(raw.area_code ?? "").trim();
    const name = String(raw.area_name ?? "").trim();
    if (!code || !name) continue;
    const area: AuArea = { areaCode: code, areaName: name, salesRegionCode: String(raw.code_region_code ?? "").trim() || null };
    byCode.set(code, area);
    byName.set(nameKey(name), area);
  }
  areaCache = { at: Date.now(), byCode, byName };
  return areaCache;
}

/** The AU area an applicant's area answer names, exactly as the directory spells it, or null. */
export async function resolveAuArea(areaName: string | null | undefined): Promise<AuArea | null> {
  const text = typeof areaName === "string" ? areaName.trim() : "";
  if (!text) return null;
  const { byName } = await loadAuAreas();
  return byName.get(nameKey(text)) ?? null;
}

/** The AU area behind a code, or null when the code is not an active area. */
export async function auAreaByCode(areaCode: string | null | undefined): Promise<AuArea | null> {
  const code = typeof areaCode === "string" ? areaCode.trim() : "";
  if (!code) return null;
  const { byCode } = await loadAuAreas();
  return byCode.get(code) ?? null;
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────

/** Every placement of these candidates, by candidate id. A candidate with none is absent. */
export async function listPlacementsFor(candidateIds: readonly string[]): Promise<Map<string, PlacementRecord[]>> {
  const out = new Map<string, PlacementRecord[]>();
  const ids = Array.from(new Set(candidateIds.filter((id) => typeof id === "string" && id.length > 0)));
  for (let start = 0; start < ids.length; start += ID_BATCH) {
    const batch = ids.slice(start, start + ID_BATCH);
    const { data, error } = await recruitmentDb().from(PLACEMENTS_TABLE).select(PLACEMENT_COLUMNS).in("candidate_id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as PlacementDbRow[]) {
      const record = mapPlacement(row);
      const list = out.get(record.candidateId);
      if (list) list.push(record);
      else out.set(record.candidateId, [record]);
    }
  }
  return out;
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────

export type UpsertPlacementInput = {
  candidateId: string;
  roleTab: WorkspaceRoleTab;
  botRoleFamily?: string | null;
  regionCode?: string | null;
  areaCode?: string | null;
  areaName?: string | null;
  placedBy: PlacedBy;
  sessionId?: string | null;
  placedByHrId?: string | null;
};

/**
 * Files the candidate in this tab. Fills the area's name and recruitment region from its AU code
 * when they are missing. An answers-made write never overwrites HR's row in the same tab: it returns
 * that row untouched.
 */
export async function upsertPlacement(input: UpsertPlacementInput): Promise<PlacementRecord> {
  let areaName = input.areaName ?? null;
  let regionCode = input.regionCode ?? null;
  if (input.areaCode && (!areaName || !regionCode)) {
    const area = await auAreaByCode(input.areaCode);
    if (area) {
      areaName = areaName ?? area.areaName;
      if (!regionCode && area.salesRegionCode) {
        regionCode = validRegionCode(recruitmentRegionForArea(area.areaName, area.salesRegionCode));
      }
    }
  }

  const db = recruitmentDb();
  if (input.placedBy !== "hr") {
    const { data: existing, error: readError } = await db
      .from(PLACEMENTS_TABLE)
      .select(PLACEMENT_COLUMNS)
      .eq("candidate_id", input.candidateId)
      .eq("role_tab", input.roleTab)
      .maybeSingle();
    if (readError) throw readError;
    if (existing && (existing as PlacementDbRow).placed_by === "hr") return mapPlacement(existing as PlacementDbRow);
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from(PLACEMENTS_TABLE)
    .upsert(
      {
        area_code: input.areaCode ?? null,
        area_name: input.areaCode ? areaName : null,
        bot_role_family: input.botRoleFamily ?? null,
        candidate_id: input.candidateId,
        placed_at: now,
        placed_by: input.placedBy,
        placed_by_hr_id: input.placedBy === "hr" ? (input.placedByHrId ?? null) : null,
        region_code: regionCode,
        role_tab: input.roleTab,
        session_id: input.sessionId ?? null,
        updated_at: now,
      },
      { onConflict: "candidate_id,role_tab" },
    )
    .select(PLACEMENT_COLUMNS)
    .single();
  if (error) throw error;
  return mapPlacement(data as PlacementDbRow);
}

export type RemovePlacementFilter = {
  candidateId: string;
  /** Only this tab. */
  roleTab?: WorkspaceRoleTab;
  /** Every tab EXCEPT this one. */
  exceptRoleTab?: WorkspaceRoleTab;
  /** Only rows made by these sources. Omitted = every source, HR's included. */
  placedBy?: readonly PlacedBy[];
  /** Only rows this WhatsApp conversation made. */
  sessionId?: string;
};

/** Takes the candidate out of one tab, whoever filed them there. HR's "remove from this tab". */
export async function removePlacement(candidateId: string, roleTab: WorkspaceRoleTab): Promise<void> {
  await removePlacementsWhere({ candidateId, roleTab });
}

/** Removes the matching placements and returns how many went. */
export async function removePlacementsWhere(filter: RemovePlacementFilter): Promise<number> {
  let query = recruitmentDb().from(PLACEMENTS_TABLE).delete().eq("candidate_id", filter.candidateId);
  if (filter.roleTab) query = query.eq("role_tab", filter.roleTab);
  if (filter.exceptRoleTab) query = query.neq("role_tab", filter.exceptRoleTab);
  if (filter.placedBy && filter.placedBy.length > 0) query = query.in("placed_by", [...filter.placedBy]);
  if (filter.sessionId) query = query.eq("session_id", filter.sessionId);
  const { data, error } = await query.select("id");
  if (error) throw error;
  return (data ?? []).length;
}

// ── From the answers ──────────────────────────────────────────────────────────────────────────

export type PlaceFromAnswersInput = {
  candidateId: string;
  roleFamily: string | null | undefined;
  regionCode: string | null | undefined;
  /** The area as the applicant gave it (or as HR corrected it). Resolved against the AU directory. */
  areaName: string | null | undefined;
  placedBy: PlacedBy;
  sessionId?: string | null;
  placedByHrId?: string | null;
};

export type PlaceFromAnswersResult =
  | { outcome: "placed"; placement: PlacementFromReply; record: PlacementRecord }
  | { outcome: "needs_placing"; removed: number }
  | { outcome: "failed"; message: string };

/**
 * Files the candidate where their answers say, and takes them out of the tab their answers no longer
 * name. Never throws: a placement is never worth failing the webhook, the careers form or an edit.
 *
 * When the answers fit no tab (the retired Human Resources tap, an area the directory does not know)
 * the person goes back to Needs placing — but only the rows THIS source made are removed: a bot
 * answer never takes away the careers form's, the one-off fill's or HR's filing.
 */
export async function placeFromAnswers(input: PlaceFromAnswersInput): Promise<PlaceFromAnswersResult> {
  try {
    const area = await resolveAuArea(input.areaName);
    const placement = placementFromReply({
      areaCode: area?.areaCode ?? null,
      areaName: area?.areaName ?? input.areaName ?? null,
      areaSalesRegionCode: area?.salesRegionCode ?? null,
      regionCode: input.regionCode,
      roleFamily: input.roleFamily,
    });

    if (!placement) {
      if (input.placedBy === "hr") return { outcome: "needs_placing", removed: 0 };
      const removed = await removePlacementsWhere({
        candidateId: input.candidateId,
        placedBy: [input.placedBy],
        ...(input.placedBy === "whatsapp" && input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      return { outcome: "needs_placing", removed };
    }

    const record = await upsertPlacement({
      areaCode: placement.areaCode,
      areaName: placement.areaName,
      botRoleFamily: placement.botRoleFamily,
      candidateId: input.candidateId,
      placedBy: input.placedBy,
      placedByHrId: input.placedByHrId ?? null,
      regionCode: placement.regionCode,
      roleTab: placement.roleTab,
      sessionId: input.sessionId ?? null,
    });
    // The answers say one thing at a time: the answers-made rows in every other tab go.
    await removePlacementsWhere({
      candidateId: input.candidateId,
      exceptRoleTab: placement.roleTab,
      placedBy: ANSWER_PLACEMENT_SOURCES,
    });
    return { outcome: "placed", placement, record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[recruitment-placements] placing from the answers failed", { candidateId: input.candidateId, message });
    return { outcome: "failed", message };
  }
}
