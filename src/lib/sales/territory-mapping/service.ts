import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Admin service for the Area / Region / Line unification reference data
 * (`public.line_area_region_map`, `public.line_zones`, `public.line_zone_regions`).
 *
 * These are small, rarely-changed lookup tables seeded by migration
 * 20260702180000_area_region_line_unification_schema.sql. `line_area_region_map` is the
 * authoritative (line, area) -> region lookup read by Sales scope resolution; `line_zones` /
 * `line_zone_regions` are DISPLAY-ONLY RM territory labels that do not drive access control.
 */

export type LineRow = { id: number; code: string; name: string };
export type RegionRow = { region_code: string; region_name: string };
export type AreaRow = { area_code: string; area_name: string; region_code: string };

export type LineAreaRegionMapRow = {
  line_id: number;
  area_code: string;
  region_code: string;
};

export type LineZoneRow = {
  zone_code: string;
  line_id: number;
  rm_hr_id: string | null;
  label: string;
};

export type LineZoneRegionRow = {
  zone_code: string;
  region_code: string;
};

export type TerritoryMappingData = {
  lines: LineRow[];
  regions: RegionRow[];
  areas: AreaRow[];
  map: LineAreaRegionMapRow[];
  zones: LineZoneRow[];
  zoneRegions: LineZoneRegionRow[];
};

/** Loads every reference list the admin screen needs in one round trip. */
export async function loadTerritoryMappingData(): Promise<TerritoryMappingData> {
  const supabase = getSupabaseAdmin();

  const [linesResult, regionsResult, areasResult, mapResult, zonesResult, zoneRegionsResult] = await Promise.all([
    supabase.from("lines").select("id, code, name").order("id", { ascending: true }),
    supabase.from("source_of_sales_regions").select("region_code, region_name").order("region_code", { ascending: true }),
    supabase.from("source_of_sales_areas").select("area_code, area_name, region_code").order("area_code", { ascending: true }),
    supabase.from("line_area_region_map").select("line_id, area_code, region_code"),
    supabase.from("line_zones").select("zone_code, line_id, rm_hr_id, label").order("zone_code", { ascending: true }),
    supabase.from("line_zone_regions").select("zone_code, region_code"),
  ]);

  for (const result of [linesResult, regionsResult, areasResult, mapResult, zonesResult, zoneRegionsResult]) {
    if (result.error) throw result.error;
  }

  // Only the 3 sales lines participate in the area/region map (Head Office is excluded — see migration).
  const lines = (linesResult.data ?? []).filter((line) => line.code !== "HO") as LineRow[];

  return {
    lines,
    regions: (regionsResult.data ?? []) as RegionRow[],
    areas: (areasResult.data ?? []) as AreaRow[],
    map: (mapResult.data ?? []) as LineAreaRegionMapRow[],
    zones: (zonesResult.data ?? []) as LineZoneRow[],
    zoneRegions: (zoneRegionsResult.data ?? []) as LineZoneRegionRow[],
  };
}

/** Upserts a single (line_id, area_code) -> region_code cell. Validates both FKs first. */
export async function upsertLineAreaRegionMap(input: {
  actorLoginId: string;
  lineId: number;
  areaCode: string;
  regionCode: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const areaCode = input.areaCode.trim().toUpperCase();
  const regionCode = input.regionCode.trim().toUpperCase();

  if (!Number.isFinite(input.lineId) || input.lineId <= 0) {
    throw new SalesWorkflowError("invalid_line", "A valid line is required.", 400);
  }
  if (!areaCode) {
    throw new SalesWorkflowError("invalid_area_code", "Area code is required.", 400);
  }
  if (!regionCode) {
    throw new SalesWorkflowError("invalid_region_code", "Region code is required.", 400);
  }

  const [lineCheck, areaCheck, regionCheck] = await Promise.all([
    supabase.from("lines").select("id").eq("id", input.lineId).maybeSingle(),
    supabase.from("source_of_sales_areas").select("area_code").eq("area_code", areaCode).maybeSingle(),
    supabase.from("source_of_sales_regions").select("region_code").eq("region_code", regionCode).maybeSingle(),
  ]);
  if (lineCheck.error) throw lineCheck.error;
  if (areaCheck.error) throw areaCheck.error;
  if (regionCheck.error) throw regionCheck.error;

  if (!lineCheck.data) {
    throw new SalesWorkflowError("unknown_line", `Line id "${input.lineId}" was not found.`, 404);
  }
  if (!areaCheck.data) {
    throw new SalesWorkflowError("unknown_area", `Area code "${areaCode}" was not found.`, 404);
  }
  if (!regionCheck.data) {
    throw new SalesWorkflowError("unknown_region", `Region code "${regionCode}" was not found.`, 404);
  }

  const { error } = await supabase
    .from("line_area_region_map")
    .upsert(
      { line_id: input.lineId, area_code: areaCode, region_code: regionCode, updated_at: new Date().toISOString() },
      { onConflict: "line_id,area_code" },
    );
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: `${input.lineId}:${areaCode}`,
    entityType: "territory_line_area_region_map",
    newValues: { lineId: input.lineId, areaCode, regionCode },
    summary: `Org Territory Mapping — set area ${areaCode} to region ${regionCode} for line ${input.lineId}.`,
  });
}

const ZONE_CODE_PATTERN = /^[A-Z0-9]+-Z\d+$/;

function normalizeRegionCodes(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const code = value.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }
  return normalized;
}

async function assertRegionsExist(regionCodes: string[]): Promise<void> {
  if (regionCodes.length === 0) return;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("source_of_sales_regions").select("region_code").in("region_code", regionCodes);
  if (error) throw error;
  const found = new Set((data ?? []).map((row) => row.region_code));
  const missing = regionCodes.filter((code) => !found.has(code));
  if (missing.length > 0) {
    throw new SalesWorkflowError("unknown_region", `Region code(s) not found: ${missing.join(", ")}.`, 404);
  }
}

/** Creates a new display-only RM territory zone with its member regions. */
export async function createLineZone(input: {
  actorLoginId: string;
  zoneCode: string;
  lineId: number;
  rmHrId: string | null;
  label: string;
  regionCodes: string[];
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const zoneCode = input.zoneCode.trim().toUpperCase();

  if (!ZONE_CODE_PATTERN.test(zoneCode)) {
    throw new SalesWorkflowError(
      "invalid_zone_code",
      'Zone code must follow the "<LINE_CODE>-Z<n>" convention, e.g. PD-Z1.',
      400,
    );
  }
  if (!Number.isFinite(input.lineId) || input.lineId <= 0) {
    throw new SalesWorkflowError("invalid_line", "A valid line is required.", 400);
  }

  const lineCheck = await supabase.from("lines").select("id, code").eq("id", input.lineId).maybeSingle();
  if (lineCheck.error) throw lineCheck.error;
  if (!lineCheck.data) {
    throw new SalesWorkflowError("unknown_line", `Line id "${input.lineId}" was not found.`, 404);
  }
  if (!zoneCode.startsWith(`${lineCheck.data.code}-Z`)) {
    throw new SalesWorkflowError(
      "zone_code_line_mismatch",
      `Zone code must start with "${lineCheck.data.code}-Z" for the selected line.`,
      400,
    );
  }

  const existing = await supabase.from("line_zones").select("zone_code").eq("zone_code", zoneCode).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    throw new SalesWorkflowError("zone_already_exists", `Zone code "${zoneCode}" already exists.`, 409);
  }

  const rmHrId = input.rmHrId?.trim() || null;
  if (rmHrId) {
    const employeeCheck = await supabase.from("employees").select("hr_id").eq("hr_id", rmHrId).maybeSingle();
    if (employeeCheck.error) throw employeeCheck.error;
    if (!employeeCheck.data) {
      throw new SalesWorkflowError("unknown_employee", `Employee HR_ID "${rmHrId}" was not found.`, 404);
    }
  }

  const regionCodes = normalizeRegionCodes(input.regionCodes);
  await assertRegionsExist(regionCodes);

  const { error: insertError } = await supabase.from("line_zones").insert({
    zone_code: zoneCode,
    line_id: input.lineId,
    rm_hr_id: rmHrId,
    label: input.label.trim(),
  });
  if (insertError) {
    const reason = insertError.code === "23505" ? `Zone code "${zoneCode}" already exists.` : insertError.message;
    throw new SalesWorkflowError("zone_insert_failed", reason, 409);
  }

  if (regionCodes.length > 0) {
    const { error: regionsError } = await supabase
      .from("line_zone_regions")
      .insert(regionCodes.map((regionCode) => ({ zone_code: zoneCode, region_code: regionCode })));
    if (regionsError) throw regionsError;
  }

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: zoneCode,
    entityType: "territory_line_zone",
    newValues: { zoneCode, lineId: input.lineId, rmHrId, label: input.label, regionCodes },
    summary: `Org Territory Mapping — created zone ${zoneCode}.`,
  });
}

/** Updates an existing zone's label / rm_hr_id / member regions (zone_code and line are immutable). */
export async function updateLineZone(input: {
  actorLoginId: string;
  zoneCode: string;
  rmHrId: string | null;
  label: string;
  regionCodes: string[];
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const zoneCode = input.zoneCode.trim().toUpperCase();

  const existing = await supabase.from("line_zones").select("zone_code").eq("zone_code", zoneCode).maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) {
    throw new SalesWorkflowError("unknown_zone", `Zone code "${zoneCode}" was not found.`, 404);
  }

  const rmHrId = input.rmHrId?.trim() || null;
  if (rmHrId) {
    const employeeCheck = await supabase.from("employees").select("hr_id").eq("hr_id", rmHrId).maybeSingle();
    if (employeeCheck.error) throw employeeCheck.error;
    if (!employeeCheck.data) {
      throw new SalesWorkflowError("unknown_employee", `Employee HR_ID "${rmHrId}" was not found.`, 404);
    }
  }

  const regionCodes = normalizeRegionCodes(input.regionCodes);
  await assertRegionsExist(regionCodes);

  const { error: updateError } = await supabase
    .from("line_zones")
    .update({ rm_hr_id: rmHrId, label: input.label.trim(), updated_at: new Date().toISOString() })
    .eq("zone_code", zoneCode);
  if (updateError) throw updateError;

  // Replace membership wholesale — the set is small (typically <= 7 regions) so a delete+insert is
  // simpler and safer than diffing, and keeps this in line with the read-modify-write UI.
  const { error: deleteError } = await supabase.from("line_zone_regions").delete().eq("zone_code", zoneCode);
  if (deleteError) throw deleteError;
  if (regionCodes.length > 0) {
    const { error: insertError } = await supabase
      .from("line_zone_regions")
      .insert(regionCodes.map((regionCode) => ({ zone_code: zoneCode, region_code: regionCode })));
    if (insertError) throw insertError;
  }

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: zoneCode,
    entityType: "territory_line_zone",
    newValues: { zoneCode, rmHrId, label: input.label, regionCodes },
    summary: `Org Territory Mapping — updated zone ${zoneCode}.`,
  });
}

/** Deletes a zone. `line_zone_regions` rows cascade via the FK on delete. */
export async function deleteLineZone(input: { actorLoginId: string; zoneCode: string }): Promise<void> {
  const supabase = getSupabaseAdmin();
  const zoneCode = input.zoneCode.trim().toUpperCase();

  const { error } = await supabase.from("line_zones").delete().eq("zone_code", zoneCode);
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: zoneCode,
    entityType: "territory_line_zone",
    oldValues: { zoneCode },
    summary: `Org Territory Mapping — deleted zone ${zoneCode}.`,
  });
}
